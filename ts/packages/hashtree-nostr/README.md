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
  requestSelectionStrategy: 'titForTat',
  requestFairnessEnabled: true,
  requestDispatch: {
    initialFanout: 2,
    hedgeFanout: 1,
    maxFanout: 8,
    hedgeIntervalMs: 120,
  },
});

await store.start();
await store.loadPeerMetadata(); // optional warm start
const data = await store.get(hash);
await store.persistPeerMetadata(); // optional shutdown/save step
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

## Signed Tree Snapshots

For immutable permalinks, store a copy of the signed kind `30078` root event as a plain hashtree blob. The snapshot gives you one signed root even when relays do not answer, and you can still watch for newer events later.

```typescript
import {
  cacheTreeEventSnapshot,
  readTreeEventSnapshot,
  fetchLatestTreeEventSnapshot,
  watchLatestTreeEventSnapshot,
} from '@hashtree/nostr';

const snapshot = await cacheTreeEventSnapshot(store, nip19, signedRootEvent);
const sameSnapshot = snapshot
  ? await readTreeEventSnapshot(store, nip19, snapshot.snapshotCid)
  : null;

const latest = await fetchLatestTreeEventSnapshot(
  { store, nip19, fetchEvents },
  'npub1...owner',
  'videos/demo',
);

const stop = watchLatestTreeEventSnapshot(
  { store, nip19, fetchEvents, subscribeEvents },
  'npub1...owner',
  'videos/demo',
  (nextSnapshot) => {
    console.log(nextSnapshot.snapshotNhash, nextSnapshot.rootCid);
  },
);

// later
stop();
```

The library does not keep a global snapshot cache for you. It provides stateless helpers plus a live watcher; route caching and reuse policy stay with the app.

## License

MIT
