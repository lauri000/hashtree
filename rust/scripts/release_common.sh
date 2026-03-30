#!/bin/bash

repo_name_from_remote_url() {
    local url="${1:-}"
    if [ -z "$url" ]; then
        return 1
    fi

    url="${url%/}"
    url="${url%.git}"

    case "$url" in
        *://*/*|git@*:*/*)
            printf '%s\n' "${url##*/}"
            ;;
        *)
            return 1
            ;;
    esac
}

infer_repo_name() {
    local repo_dir="$1"
    local remote url name top

    for remote in origin github upstream; do
        url="$(git -C "$repo_dir" config --get "remote.${remote}.url" 2>/dev/null || true)"
        name="$(repo_name_from_remote_url "$url" || true)"
        if [ -n "$name" ]; then
            printf '%s\n' "$name"
            return 0
        fi
    done

    top="$(git -C "$repo_dir" rev-parse --show-toplevel 2>/dev/null || printf '%s\n' "$repo_dir")"
    basename "$top"
}

current_npub() {
    local user_output

    user_output="$(htree user 2>&1 || true)"
    printf '%s\n' "$user_output" \
        | grep -oE 'npub1[023456789acdefghjklmnpqrstuvwxyz]+' \
        | head -n1
}
