#!/bin/bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: rust/scripts/write_release_bootstrap_installer.sh --path <path> --base-url <url>

Writes the top-level install.sh bootstrap used by release directories. The
script downloads the platform archive from the same release origin and then
delegates to the packaged installer inside the archive.
EOF
}

PATH_ARG=""
BASE_URL=""

while [ $# -gt 0 ]; do
    case "$1" in
        --path)
            PATH_ARG="${2:-}"
            shift 2
            ;;
        --base-url)
            BASE_URL="${2:-}"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [ -z "$PATH_ARG" ] || [ -z "$BASE_URL" ]; then
    usage >&2
    exit 1
fi

mkdir -p "$(dirname "$PATH_ARG")"

cat >"$PATH_ARG" <<EOF
#!/bin/sh
set -eu

BASE_URL="${BASE_URL}"
ASSET_BASE_URL="\${BASE_URL}/assets"

# This bootstrap is the trust root for curl|sh installs. Same-origin checksum
# files would not improve security here, so it downloads the release archive
# directly and delegates to the packaged installer.

require_command() {
    if ! command -v "\$1" >/dev/null 2>&1; then
        echo "Missing required command: \$1" >&2
        exit 1
    fi
}

detect_arch() {
    case "\$(uname -m)" in
        arm64|aarch64)
            printf '%s\n' aarch64
            ;;
        x86_64|amd64)
            printf '%s\n' x86_64
            ;;
        *)
            echo "Unsupported architecture: \$(uname -m)" >&2
            exit 1
            ;;
    esac
}

detect_os() {
    case "\$(uname -s)" in
        Darwin)
            printf '%s\n' apple-darwin
            ;;
        Linux)
            printf '%s\n' unknown-linux-musl
            ;;
        *)
            echo "Unsupported operating system: \$(uname -s)" >&2
            exit 1
            ;;
    esac
}

require_command curl
require_command tar
require_command mktemp

target="\$(detect_arch)-\$(detect_os)"
archive="hashtree-\${target}.tar.gz"
tmpdir="\$(mktemp -d 2>/dev/null || mktemp -d -t hashtree-install)"
trap 'rm -rf "\$tmpdir"' EXIT HUP INT TERM

curl -fsSL "\${ASSET_BASE_URL}/\${archive}" -o "\${tmpdir}/\${archive}"
tar -xzf "\${tmpdir}/\${archive}" -C "\${tmpdir}"

cd "\${tmpdir}/hashtree"
exec ./install.sh "\$@"
EOF

chmod +x "$PATH_ARG"
