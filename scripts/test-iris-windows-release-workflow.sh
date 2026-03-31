#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

grep -F "tauri_bundles: nsis" .github/workflows/ci.yml >/dev/null
if grep -F "tauri_bundles: nsis,msi" .github/workflows/ci.yml >/dev/null; then
  echo "CI workflow still builds MSI for Iris on Windows" >&2
  exit 1
fi

grep -F "tauri build --target x86_64-pc-windows-msvc --bundles nsis --ci" .github/workflows/release.yml >/dev/null
grep -F 'Copy-Item $nsis.FullName "dist/$env:IRIS_ASSET_PREFIX-windows-x64-setup.exe"' .github/workflows/release.yml >/dev/null
grep -F 'name: iris-windows-x64' .github/workflows/release.yml >/dev/null
grep -F "pattern: iris-*" .github/workflows/release.yml >/dev/null
grep -F 'render_args+=(--iris-assets-dir artifacts/iris)' .github/workflows/release.yml >/dev/null
grep -F 'macOS Iris release asset unavailable: ${IRIS_MACOS_RELEASE_REASON}' .github/workflows/release.yml >/dev/null

if grep -F "if: needs.build-macos-app.outputs.release_ready == 'true'" .github/workflows/release.yml >/dev/null; then
  echo "Release workflow still gates all Iris artifacts on macOS readiness" >&2
  exit 1
fi

if rg -F "iris-windows-x64.msi" .github/workflows/release.yml >/dev/null; then
  echo "Release workflow still references MSI artifacts for Iris on Windows" >&2
  exit 1
fi

echo "Iris Windows release workflow checks passed."
