# @hashtree/worker

Modular browser worker for hashtree blob caching and Blossom connectivity.

Runs hashtree storage operations in a Web Worker to keep the main thread free. Handles IndexedDB caching, Blossom server uploads/downloads, connectivity probing, and WebRTC P2P data exchange.

## Install

```bash
npm install @hashtree/worker
```

## Usage

```typescript
import { HashtreeWorkerClient } from '@hashtree/worker';

const client = new HashtreeWorkerClient({ workerFactory });

await client.configure({
  blossomServers: [{ url: 'https://upload.iris.to', read: true, write: true }],
});

// Store and retrieve blobs
await client.put(hash, data);
const blob = await client.get(hash);
```

## Exports

- `@hashtree/worker` — `HashtreeWorkerClient` for main-thread use
- `@hashtree/worker/p2p` — `WebRTCController` / `WebRTCProxy` for P2P data channel management
- `@hashtree/worker/entry` — Worker entry point
- `@hashtree/worker/protocol` — Shared message types between main thread and worker

## License

MIT
