# @hashtree/nostr

WebRTC P2P storage and Nostr ref resolver for hashtree.

## Install

```bash
npm install @hashtree/nostr
```

## WebRTC Store

P2P data fetching via WebRTC with Nostr signaling:

```typescript
import { WebRTCStore } from '@hashtree/nostr';

const store = new WebRTCStore({
  signer,    // NIP-07 compatible
  pubkey,
  encrypt,   // NIP-44
  decrypt,
  localStore,
  relays: ['wss://relay.example.com'],
});

await store.start();
const data = await store.get(hash);
```

## Nostr Ref Resolver

Resolve `npub/treename` references to merkle root hashes via Nostr events.

### Event Format

Trees are published as **kind 30078** (parameterized replaceable with label):

```
npub1abc.../treename/path/to/file.ext
      │        │           │
      │        │           └── Path within merkle tree (client-side traversal)
      │        └── d-tag value (tree identifier)
      └── Author pubkey (bech32 → hex for event)
```

**Tags:**
| Tag | Purpose |
|-----|---------|
| `d` | Tree name (replaceable event key) |
| `l` | `"hashtree"` label for discovery |
| `hash` | Merkle root SHA256 (64 hex chars) |
| `key` | Decryption key (public trees) |
| `encryptedKey` | XOR'd key (link-visible trees) |
| `selfEncryptedKey` | NIP-44 encrypted (private/link-visible) |

**Visibility:**
- **Public**: plaintext `key` tag
- **Link-visible**: `encryptedKey` + link key in share URL
- **Private**: only `selfEncryptedKey` (owner access)

### Usage

```typescript
import { createNostrRefResolver } from '@hashtree/nostr';

const resolver = createNostrRefResolver({
  subscribe: (filters, onEvent) => { /* NDK subscribe */ },
  publish: (event) => { /* NDK publish */ },
});

const root = await resolver.resolve('npub1.../myfiles');
```

## License

MIT
