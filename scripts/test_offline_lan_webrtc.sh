#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-hashtree-offline-lan:test}"
# Docker's internal bridge commonly lacks a multicast route, which breaks LAN discovery.
# Use a regular bridge by default; callers can still override this for stricter setups.
DOCKER_NETWORK_CREATE_ARGS="${DOCKER_NETWORK_CREATE_ARGS:---driver bridge}"
NETWORK_NAME="hashtree-offline-lan-$RANDOM"
PEER_A="hashtree-offline-a-$RANDOM"
PEER_B="hashtree-offline-b-$RANDOM"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hashtree-offline-lan.XXXXXX")"
PEER_A_DIR="$WORK_DIR/peer-a"
PEER_B_DIR="$WORK_DIR/peer-b"
PAYLOAD_DIR="$WORK_DIR/payload"
IMAGE_BUILD_DIR="$WORK_DIR/image"
CARGO_TARGET_DIR="$WORK_DIR/cargo-target"
HTREE_BIN="$CARGO_TARGET_DIR/release/htree"
TREE_NAME="lan-tree"
PAYLOAD_FILE="hello.txt"
PAYLOAD_TEXT="hello from offline lan multicast"

mkdir -p \
    "$PEER_A_DIR/config" "$PEER_A_DIR/data" \
    "$PEER_B_DIR/config" "$PEER_B_DIR/data" \
    "$PAYLOAD_DIR" \
    "$IMAGE_BUILD_DIR" \
    "$CARGO_TARGET_DIR"
printf '%s\n' "$PAYLOAD_TEXT" >"$PAYLOAD_DIR/$PAYLOAD_FILE"

cleanup() {
    local status=$?
    if [[ $status -ne 0 ]]; then
        echo "offline docker test failed, dumping container logs" >&2
        docker logs "$PEER_A" >&2 || true
        docker logs "$PEER_B" >&2 || true
    fi
    docker rm -f "$PEER_A" "$PEER_B" >/dev/null 2>&1 || true
    docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK_DIR"
    exit "$status"
}
trap cleanup EXIT

write_config() {
    local target_dir=$1
    cat >"$target_dir/config/config.toml" <<'EOF'
[server]
bind_address = "0.0.0.0:8080"
enable_auth = false
stun_port = 0
enable_webrtc = true
enable_multicast = true
multicast_group = "239.255.42.98"
multicast_port = 48555
max_multicast_peers = 4
public_writes = true

[storage]
max_size_gb = 1

[nostr]
relays = ["ws://127.0.0.1:8080/ws"]
allowed_npubs = []
crawl_depth = 0
max_write_distance = 0
db_max_size_gb = 1
spambox_max_size_gb = 0

[blossom]
servers = []
read_servers = []
write_servers = []
max_upload_mb = 5

[sync]
enabled = false
sync_own = false
sync_followed = false
max_concurrent = 1
webrtc_timeout_ms = 2000
blossom_timeout_ms = 2000
EOF
}

wait_for_condition() {
    local timeout_secs=$1
    local description=$2
    shift 2
    local deadline=$((SECONDS + timeout_secs))
    until "$@"; do
        if (( SECONDS >= deadline )); then
            echo "timed out waiting for: $description" >&2
            return 1
        fi
        sleep 1
    done
}

container_ready() {
    local container=$1
    docker exec "$container" curl -fsS http://127.0.0.1:8080/htree/test >/dev/null
}

container_has_data_channel() {
    local container=$1
    docker exec "$container" sh -lc \
        "curl -fsS http://127.0.0.1:8080/api/peers | grep -q '\"with_data_channel\":1'"
}

container_has_discovered_peer() {
    local container=$1
    docker exec "$container" sh -lc \
        "curl -fsS http://127.0.0.1:8080/api/peers | grep -Eq '\"total\":[1-9][0-9]*'"
}

container_resolve_offline() {
    local container=$1
    local owner_pubkey_hex=$2
    local output
    output="$(docker exec "$container" curl -fsS "http://127.0.0.1:8080/api/resolve/$owner_pubkey_hex/$TREE_NAME")"
    if [[ "$output" == *'"cid":"'*
        && "$output" != *'"source":"nostr"'* ]]; then
        printf '%s\n' "$output" >&2
        return 0
    fi
    return 1
}

container_fetch_payload() {
    local container=$1
    local owner_npub=$2
    local output
    output="$(docker exec "$container" curl -fsS "http://127.0.0.1:8080/htree/$owner_npub/$TREE_NAME/$PAYLOAD_FILE")"
    [[ "$output" == "$PAYLOAD_TEXT" ]]
}

container_has_received_bytes() {
    local container=$1
    docker exec "$container" sh -lc \
        "curl -fsS http://127.0.0.1:8080/api/status | grep -Eq '\"bytes_received\":[1-9][0-9]*'"
}

write_config "$PEER_A_DIR"
write_config "$PEER_B_DIR"

echo "building docker image $IMAGE_TAG"
docker run --rm \
    -v "$ROOT_DIR/rust:/app" \
    -v "$CARGO_TARGET_DIR:/cargo-target" \
    -w /app \
    -e CARGO_TARGET_DIR=/cargo-target \
    rust:1-bookworm \
    cargo build --locked --release --package hashtree-cli --features s3

cp "$HTREE_BIN" "$IMAGE_BUILD_DIR/htree"
cat >"$IMAGE_BUILD_DIR/Dockerfile" <<'EOF'
FROM node:22-bookworm

COPY htree /usr/local/bin/htree

WORKDIR /data

EXPOSE 8080

CMD ["htree", "start", "--addr", "0.0.0.0:8080", "--data-dir", "/data"]
EOF

docker build --pull=false --progress=plain -t "$IMAGE_TAG" "$IMAGE_BUILD_DIR"

echo "creating isolated docker network $NETWORK_NAME"
# shellcheck disable=SC2086
docker network create $DOCKER_NETWORK_CREATE_ARGS "$NETWORK_NAME" >/dev/null

echo "starting peer containers"
docker run -d \
    --name "$PEER_A" \
    --network "$NETWORK_NAME" \
    -e HTREE_CONFIG_DIR=/config \
    -e HTREE_DATA_DIR=/data \
    -v "$PEER_A_DIR/config:/config" \
    -v "$PEER_A_DIR/data:/data" \
    -v "$PAYLOAD_DIR:/payload:ro" \
    "$IMAGE_TAG" >/dev/null

docker run -d \
    --name "$PEER_B" \
    --network "$NETWORK_NAME" \
    -e HTREE_CONFIG_DIR=/config \
    -e HTREE_DATA_DIR=/data \
    -v "$PEER_B_DIR/config:/config" \
    -v "$PEER_B_DIR/data:/data" \
    "$IMAGE_TAG" >/dev/null

echo "waiting for daemons"
wait_for_condition 60 "peer a health endpoint" container_ready "$PEER_A"
wait_for_condition 60 "peer b health endpoint" container_ready "$PEER_B"

echo "waiting for LAN discovery"
wait_for_condition 90 "peer a discovered peer b" container_has_discovered_peer "$PEER_A"
wait_for_condition 90 "peer b discovered peer a" container_has_discovered_peer "$PEER_B"

NPUB_A="$(docker exec "$PEER_A" htree --data-dir /data user | tail -n 1 | tr -d '\r')"
echo "peer a npub: $NPUB_A"

PEERS_JSON="$(docker exec "$PEER_B" curl -fsS http://127.0.0.1:8080/api/peers)"
OWNER_PUBKEY_HEX="$(printf '%s' "$PEERS_JSON" | sed -n 's/.*"pubkey":"\([0-9a-f]\{64\}\)".*/\1/p' | head -n 1)"
if [[ -z "$OWNER_PUBKEY_HEX" ]]; then
    echo "failed to discover peer a pubkey from peer b status" >&2
    exit 1
fi
echo "peer a pubkey: $OWNER_PUBKEY_HEX"

echo "publishing payload and tree root from peer a"
docker exec "$PEER_A" htree --data-dir /data add /payload --publish "$TREE_NAME" --local --unencrypted >/dev/null

echo "waiting for offline root resolution on peer b"
wait_for_condition 60 "peer b offline root resolution" \
    container_resolve_offline "$PEER_B" "$OWNER_PUBKEY_HEX"

echo "waiting for WebRTC data channels"
wait_for_condition 90 "peer a connected data channel" container_has_data_channel "$PEER_A"
wait_for_condition 90 "peer b connected data channel" container_has_data_channel "$PEER_B"

echo "fetching published data from peer b over WebRTC"
wait_for_condition 60 "peer b fetches published payload" \
    container_fetch_payload "$PEER_B" "$NPUB_A"

echo "verifying peer b recorded inbound WebRTC bytes"
wait_for_condition 30 "peer b bytes received" container_has_received_bytes "$PEER_B"

echo "offline LAN docker test passed"
