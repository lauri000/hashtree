# HTS-01: hashtree Core Protocol

This document defines the interoperable wire/data formats for hashtree.

## 1. Scope

This spec defines:

1. Content addressing and node encoding.
2. CHK encryption.
3. `nhash` identifiers and `npub/path` references.
4. Mutable root publication on Nostr.
5. `htree://` Git URL profile.
6. Optional WebRTC blob exchange profile.

## 2. Content Addressing Model

1. Hash function MUST be SHA-256.
2. Hashes are 32 bytes.
3. Blob address is `SHA256(blob_bytes)`.
4. Tree-node address is `SHA256(msgpack_tree_node_bytes)`.
5. Storage interface is key-value by hash:
   `put(hash, bytes)` and `get(hash) -> bytes?`.

## 3. Tree Node Wire Format

Stored values are either:

1. Blob: raw bytes (not wrapped).
2. Tree node: MessagePack map with compact keys.

Node map:

- `t` (u8): node type. MUST be `1` (File) or `2` (Dir).
- `l` (array): links.

Link map:

- `h` (bytes32): child hash. REQUIRED.
- `s` (u64): child size in bytes. REQUIRED.
- `t` (u8): link type. Optional, default `0`.
- `n` (utf8): entry name. Optional (used in directories).
- `k` (bytes32): child CHK key. Optional.
- `m` (map): metadata. Optional.

Type values:

- `0` = Blob
- `1` = File
- `2` = Dir

Determinism requirements:

1. Encoders MUST produce deterministic MessagePack for identical logical nodes.
2. Metadata map keys MUST be lexicographically sorted before encoding.
3. Directory entry ordering MUST be deterministic (name sort is RECOMMENDED).

Decoding rules:

1. Unknown/missing link `t` MUST be treated as `Blob`.
2. Node `t` other than `1`/`2` MUST be rejected as invalid tree node.

## 4. Chunking and Fanout Defaults

Recommended defaults:

1. Chunk size: `2 MiB`.
2. Max links per node: `174`.

These affect tree shape and root hash; they are defaults, not protocol constants.

## 5. CHK Encryption

CHK (Content Hash Key) is deterministic convergent encryption.

For plaintext `P`:

1. `content_hash = SHA256(P)` (32 bytes).
2. `enc_key = HKDF-SHA256(ikm=content_hash, salt="hashtree-chk", info="encryption-key", L=32)`.
3. `ciphertext = AES-256-GCM(enc_key, nonce=0x000000000000000000000000, aad="", plaintext=P)`.
4. Stored bytes are AES-GCM output (`ciphertext || 16-byte tag`).
5. The CID key is `content_hash` (not `enc_key`).

Properties:

1. Same plaintext => same key and ciphertext.
2. CHK key is a capability; anyone with hash+key can decrypt.
3. CHK leaks equality: identical plaintext produces identical ciphertext.

## 6. CIDs and Bech32 IDs

CID (**Content Identifier**) is the tuple `{hash, key?}` where:

- `hash` is the 32-byte content address.
- `key` is an optional 32-byte CHK decryption key.

### 6.1 CID text form

`<hash_hex>` or `<hash_hex>:<key_hex>` where each is 64 hex chars.

### 6.2 `nhash`

Human-readable permalink. HRP MUST be `nhash` (Bech32, not Bech32m).

Payload is TLV (Type-Length-Value) bytes.
TLV bytes are a sequence of repeated fields: `[type:1][len:1][value:len]`.

TLV types:

- `0`: hash (bytes32), REQUIRED.
- `5`: decrypt key (bytes32), OPTIONAL.

### 6.3 Mutable reference form (`npub/path`)

Mutable references SHOULD use path form instead of a separate bech32 code:

- `<npub>/<tree_or_repo_path>`

For link-visible access, a key MAY be provided as query parameter:

- `?k=<64-hex>`
- `k` is the 32-byte link secret used to recover the root CHK key from the Nostr `encryptedKey` tag:
  `root_key = encryptedKey XOR k`

`hashtree:` URI prefix MAY appear before `nhash` and MUST be ignored by decoders.

## 7. Mutable Roots via Nostr

Root events use kind `30078` and NIP-33 replaceable semantics (`d` tag).

Required tags:

- `["d", "<tree_name>"]`
- `["l", "hashtree"]` (legacy unlabeled events MAY be accepted for compatibility)
- `["hash", "<64-hex-root-hash>"]`

Visibility tags (choose zero or one):

- no visibility tag: unencrypted root/content
- `["key", "<64-hex-chk-key>"]` for public CHK
- `["encryptedKey", "<64-hex-xor-masked-key>"]` for link-visible (`encryptedKey = root_key XOR link_secret`)
- `["selfEncryptedKey", "<nip44-v2-ciphertext>"]` for private

Event `content` is optional. Producers SHOULD set empty string or the root hash for legacy compatibility. Consumers MUST prefer `hash` tag and MAY fallback to legacy content.

When multiple events match author + `d`:

1. Select newest `created_at`.
2. If tied, select larger event id.

## 8. Visibility Modes

### 8.1 Unencrypted

- No CHK key is required.
- Event omits `key`, `encryptedKey`, and `selfEncryptedKey`.

### 8.2 Public (CHK)

- Root CHK key is in `key` tag.

### 8.3 Link-visible

- Share secret `S` is 32 bytes.
- Event stores `encryptedKey = root_key XOR S`.
- Clone/share URL includes `?k=<hex(S)>`.
- Client decryption flow is: `root_key = encryptedKey XOR k`.

### 8.4 Private

- Event stores `selfEncryptedKey = NIP-44(key_hex encrypted to owner pubkey)`.
- Only owner can decrypt.

## 9. `htree://` URL Profile

Syntax:

`htree://<identifier>/<repo_or_tree_path>[#<fragment>]`

Rules:

1. `identifier` MAY be `npub1...`, 64-hex pubkey, petname alias, or `self`.
2. Path after first `/` is repo/tree name and MAY include `/`.
3. `:` separator form is invalid.

Fragments:

- none: public mode
- `#k=<64-hex>`: link-visible with explicit share secret
- `#link-visible`: create-time request to auto-generate secret
- `#private`: private (author-only)

Unknown fragments MUST be rejected.

## 10. Git Repository Profile (Optional)

The current git profile maps git state into hashtree with root layout:

1. `/.git/HEAD`
2. `/.git/refs/...`
3. `/.git/objects/<2-hex>/<38-hex>` (zlib-compressed loose objects)

Repository publication uses Section 7 with `d=<repo_path>`.

## 11. WebRTC Blob Exchange Profile (Optional)

Binary frame format:

1. First byte = message type.
2. Remaining bytes = MessagePack map body.

Types:

- `0x00` request: `{h: bytes32, htl?: u8}`
- `0x01` response: `{h: bytes32, d: bytes, i?: u32, n?: u32}`

`i`/`n` are fragment index/total for chunked responses.
Recommended fragment size is `32 KiB`.

### 11.1 `htl` behavior

`htl` (hops-to-live) is a request-scoped forwarding budget.
`MAX_HTL` is the profile default maximum (currently `10`).

Rules:

1. If `htl` is omitted, receiver MUST treat it as `MAX_HTL`.
2. A peer MAY forward only when `htl > 0`.
3. A peer that forwards MUST decrement `htl` before sending to the next peer.
4. Decrement policy is Freenet-style:
   - `2..(MAX_HTL-1)`: decrement by `1`.
   - `MAX_HTL`: decrement is probabilistic per peer (commonly 50%).
   - `1`: decrement to `0` is probabilistic per peer (commonly 25%).
5. `htl = 0` MUST NOT be forwarded.

### 11.2 `htl` rationale

`htl` bounds request spread so misses do not flood the network.
Probabilistic decrement at boundary values (`MAX_HTL` and `1`) makes path length less predictable across peers, reducing simple origin/distance probing.
