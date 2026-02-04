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
exec cargo run -p hashtree-cli -- start --addr "${ADDR}"
