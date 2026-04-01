#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

ADDR="${HTREE_ADDR:-127.0.0.1:18780}"
CONFIG_DIR="${HTREE_CONFIG_DIR:-/tmp/htree-e2e-blossom}"
DATA_DIR="${HTREE_DATA_DIR:-/tmp/htree-e2e-blossom-data}"

mkdir -p "${CONFIG_DIR}" "${DATA_DIR}"

cat > "${CONFIG_DIR}/config.toml" <<EOF
[server]
bind_address = "${ADDR}"
enable_auth = false
public_writes = true
enable_webrtc = false
stun_port = 0

[storage]
data_dir = "${DATA_DIR}"
max_size_gb = 1

[nostr]
relays = []
allowed_npubs = []
crawl_depth = 0
db_max_size_gb = 1
spambox_max_size_gb = 0

[blossom]
servers = []
read_servers = []
write_servers = []
max_upload_mb = 50

[sync]
enabled = false
EOF

export HTREE_CONFIG_DIR="${CONFIG_DIR}"

cd "${ROOT_DIR}/rust"
CARGO_TARGET_DIR="${HTREE_E2E_RUST_TARGET_DIR:-${ROOT_DIR}/rust/target}"
HTREE_BIN="${CARGO_TARGET_DIR}/debug/htree"
RUST_LOCK_PATH="${HTREE_RUST_LOCK_PATH:-/tmp/rust-e2e.lock}"
RUST_LOCK_TIMEOUT_SECS="${HTREE_RUST_LOCK_TIMEOUT_SECS:-240}"

lock_mtime() {
  if stat -f %m "$1" >/dev/null 2>&1; then
    stat -f %m "$1"
  else
    stat -c %Y "$1"
  fi
}

acquire_rust_lock() {
  local start now mtime age
  start="$(date +%s)"
  while true; do
    if ( set -o noclobber; : > "${RUST_LOCK_PATH}" ) 2>/dev/null; then
      return 0
    fi

    if [[ -e "${RUST_LOCK_PATH}" ]]; then
      now="$(date +%s)"
      mtime="$(lock_mtime "${RUST_LOCK_PATH}" 2>/dev/null || echo "${now}")"
      age=$(( now - mtime ))
      if (( age > RUST_LOCK_TIMEOUT_SECS )); then
        rm -f "${RUST_LOCK_PATH}"
        continue
      fi
      if (( now - start > RUST_LOCK_TIMEOUT_SECS )); then
        echo "Timed out waiting for rust lock: ${RUST_LOCK_PATH}" >&2
        return 1
      fi
    fi

    sleep 1
  done
}

release_rust_lock() {
  rm -f "${RUST_LOCK_PATH}"
}

ensure_htree_bin() {
  if [[ -x "${HTREE_BIN}" ]]; then
    return 0
  fi

  acquire_rust_lock
  trap release_rust_lock EXIT

  if [[ ! -x "${HTREE_BIN}" ]]; then
    CARGO_TARGET_DIR="${CARGO_TARGET_DIR}" cargo build --bin htree --features p2p
  fi

  release_rust_lock
  trap - EXIT
}

ensure_htree_bin
exec "${HTREE_BIN}" start --addr "${ADDR}"
