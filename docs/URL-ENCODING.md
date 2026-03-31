# URL Encoding

- A published tree name is one logical segment, even when the name contains `/`.
- In `htree://`, `/htree/...`, and generic site/upload HTTP paths, encode that tree name as one path segment before joining the URL.
- Split the path into segments first, then decode each segment. Do not decode the full path and then split it.

Examples:

- `releases/nostr-vpn` becomes `releases%2Fnostr-vpn`
- `htree://npub1.../releases%2Fnostr-vpn/v0.3.0/assets/nostr-vpn-v0.3.0-macos-arm64.zip`
- `/htree/npub1.../releases%2Fnostr-vpn/v0.3.0/assets/nostr-vpn-v0.3.0-macos-arm64.zip`
- `/npub1.../releases%2Fnostr-vpn`
