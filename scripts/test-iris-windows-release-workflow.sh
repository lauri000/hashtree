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
grep -F "Copy-Item \$nsis.FullName 'dist/iris-windows-x64-setup.exe'" .github/workflows/release.yml >/dev/null
grep -F "Run \`iris-windows-x64-setup.exe\`." .github/workflows/release.yml >/dev/null

if rg -F "iris-windows-x64.msi" .github/workflows/release.yml >/dev/null; then
  echo "Release workflow still references MSI artifacts for Iris on Windows" >&2
  exit 1
fi

echo "Iris Windows release workflow checks passed."
