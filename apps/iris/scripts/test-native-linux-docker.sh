#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${APP_DIR}/../.." && pwd)"
DOCKERFILE="${SCRIPT_DIR}/Dockerfile.native-linux-smoke"
IMAGE_NAME="${IRIS_NATIVE_DOCKER_IMAGE:-hashtree/iris-native-linux-smoke}"
SHM_SIZE="${IRIS_NATIVE_DOCKER_SHM_SIZE:-2g}"

case "${IRIS_NATIVE_DOCKER_PLATFORM:-}" in
  "")
    case "$(uname -m)" in
      arm64|aarch64)
        PLATFORM="linux/arm64"
        ;;
      x86_64|amd64)
        PLATFORM="linux/amd64"
        ;;
      *)
        PLATFORM="linux/amd64"
        ;;
    esac
    ;;
  *)
    PLATFORM="${IRIS_NATIVE_DOCKER_PLATFORM}"
    ;;
esac

docker build \
  --platform "${PLATFORM}" \
  -f "${DOCKERFILE}" \
  -t "${IMAGE_NAME}" \
  "${SCRIPT_DIR}"

docker run --rm \
  --platform "${PLATFORM}" \
  --shm-size "${SHM_SIZE}" \
  -v "${REPO_ROOT}:/workspace" \
  -v hashtree-iris-native-node-modules:/workspace/apps/iris/node_modules \
  -v hashtree-iris-native-pnpm-store:/pnpm/store \
  -v hashtree-iris-native-target:/workspace/apps/iris/src-tauri/target \
  -v hashtree-iris-native-cargo-registry:/root/.cargo/registry \
  -v hashtree-iris-native-cargo-git:/root/.cargo/git \
  -w /workspace/apps/iris \
  "${IMAGE_NAME}" \
  bash -lc '
    set -euo pipefail
    pnpm config set store-dir /pnpm/store
    pnpm install --frozen-lockfile
    DBUS_SESSION_BUS_ADDRESS= dbus-run-session -- xvfb-run -a bash -lc '"'"'
      set -euo pipefail
      openbox >/tmp/openbox.log 2>&1 &
      pnpm run test:native:linux
    '"'"'
  '
