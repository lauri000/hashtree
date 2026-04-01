#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PUBLISH_SCRIPT="${RUST_DIR}/scripts/publish.sh"

PLAN_OUTPUT="$("${PUBLISH_SCRIPT}" --plan)"

printf '%s\n' "$PLAN_OUTPUT" | grep -Fx 'cashu-service' >/dev/null
printf '%s\n' "$PLAN_OUTPUT" | grep -Fx 'hashtree-fuse' >/dev/null

cashu_line="$(printf '%s\n' "$PLAN_OUTPUT" | nl -ba | awk '$2 == "cashu-service" { print $1; exit }')"
fuse_line="$(printf '%s\n' "$PLAN_OUTPUT" | nl -ba | awk '$2 == "hashtree-fuse" { print $1; exit }')"
cli_line="$(printf '%s\n' "$PLAN_OUTPUT" | nl -ba | awk '$2 == "hashtree-cli" { print $1; exit }')"

if [ -z "$cashu_line" ] || [ -z "$fuse_line" ] || [ -z "$cli_line" ]; then
    echo "Failed to find cashu-service, hashtree-fuse, or hashtree-cli in publish plan" >&2
    exit 1
fi

if [ "$cashu_line" -ge "$cli_line" ]; then
    echo "cashu-service must be published before hashtree-cli" >&2
    exit 1
fi

if [ "$fuse_line" -ge "$cli_line" ]; then
    echo "hashtree-fuse must be published before hashtree-cli" >&2
    exit 1
fi

echo "test_publish_plan.sh passed"
