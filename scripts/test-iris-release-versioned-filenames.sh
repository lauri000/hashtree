#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

grep -F 'RELEASE_TAG: ${{ github.event.inputs.tag || github.ref_name }}' .github/workflows/release.yml >/dev/null

grep -F 'ditto -c -k --sequesterRsrc --keepParent "${APP_PATH}" "dist/iris-${RELEASE_TAG}-macos-arm64.zip"' .github/workflows/release.yml >/dev/null
grep -F 'ditto -x -k "dist/iris-${RELEASE_TAG}-macos-arm64.zip" "${VERIFY_DIR}"' .github/workflows/release.yml >/dev/null
grep -F 'path: dist/iris-${{ env.RELEASE_TAG }}-macos-arm64.zip' .github/workflows/release.yml >/dev/null

grep -F 'cp "${appimage}" "dist/iris-${RELEASE_TAG}-linux-x86_64.AppImage"' .github/workflows/release.yml >/dev/null
grep -F 'cp "${deb}" "dist/iris-${RELEASE_TAG}-linux-x86_64.deb"' .github/workflows/release.yml >/dev/null
grep -F 'sha256sum "dist/iris-${RELEASE_TAG}-linux-x86_64.AppImage" > "dist/iris-${RELEASE_TAG}-linux-x86_64.AppImage.sha256"' .github/workflows/release.yml >/dev/null
grep -F 'sha256sum "dist/iris-${RELEASE_TAG}-linux-x86_64.deb" > "dist/iris-${RELEASE_TAG}-linux-x86_64.deb.sha256"' .github/workflows/release.yml >/dev/null
grep -F 'path: dist/iris-${{ env.RELEASE_TAG }}-linux-x86_64*' .github/workflows/release.yml >/dev/null

grep -F 'Download `iris-${{ env.RELEASE_TAG }}-macos-arm64.zip`' .github/workflows/release.yml >/dev/null
grep -F 'Download `iris-${{ env.RELEASE_TAG }}-linux-x86_64.AppImage`' .github/workflows/release.yml >/dev/null
grep -F 'iris-${{ env.RELEASE_TAG }}-linux-x86_64.deb' .github/workflows/release.yml >/dev/null
grep -F 'iris-${{ env.RELEASE_TAG }}-windows-x64-setup.exe' .github/workflows/release.yml >/dev/null

echo "Iris release filenames include the release tag across all platforms."
