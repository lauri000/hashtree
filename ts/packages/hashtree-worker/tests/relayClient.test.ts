import { describe, expect, it } from 'vitest';
import type { WorkerRequest, WorkerResponse } from '../src/relay/protocol.js';
import { RelayWorkerClient, type TreeRootInfo, type TreeRootUpdate } from '../src/relay-client.js';

const ROOT_INFO: TreeRootInfo = {
  hash: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
  key: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
  visibility: 'link-visible',
  labels: ['sites'],
  updatedAt: 1700000000,
  snapshotNhash: 'nhash1snapshot',
  encryptedKey: 'ab'.repeat(32),
};

class FakeRelayWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly messages: WorkerRequest[] = [];

  postMessage(message: WorkerRequest, _transfer?: Transferable[]): void {
    this.messages.push(message);

    if (message.type === 'init') {
      this.emit({ type: 'ready' });
      return;
    }

    if (message.type === 'getTreeRootInfo') {
      this.emit({ type: 'treeRootInfo', id: message.id, record: ROOT_INFO });
      return;
    }

    if (message.type === 'subscribeTreeRoots') {
      this.emit({ type: 'void', id: message.id });
      queueMicrotask(() => {
        this.emit({
          type: 'treeRootUpdate',
          npub: message.pubkey,
          treeName: 'sites/example',
          ...ROOT_INFO,
        } satisfies TreeRootUpdate);
      });
      return;
    }

    if (message.type === 'unsubscribeTreeRoots' || message.type === 'close') {
      this.emit({ type: 'void', id: message.id });
    }
  }

  terminate(): void {
    // no-op
  }

  private emit(message: WorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }
}

describe('RelayWorkerClient', () => {
  it('returns tree root info through the relay worker protocol', async () => {
    const client = new RelayWorkerClient(FakeRelayWorker as unknown as new () => Worker, {
      storeName: 'demo-sites-worker',
      relays: ['wss://relay.example'],
      blossomServers: [{ url: 'https://upload.example', read: false, write: true }],
      pubkey: '11'.repeat(32),
    });

    await expect(client.getTreeRootInfo('npub1example', 'sites/example')).resolves.toEqual(ROOT_INFO);

    await client.close();
  });

  it('emits tree root updates from the worker', async () => {
    const client = new RelayWorkerClient(FakeRelayWorker as unknown as new () => Worker, {
      storeName: 'demo-sites-worker',
      relays: ['wss://relay.example'],
      blossomServers: [{ url: 'https://upload.example', read: false, write: true }],
      pubkey: '11'.repeat(32),
    });
    const updates: TreeRootUpdate[] = [];

    const unsubscribe = client.onTreeRootUpdate((update) => {
      updates.push(update);
    });

    await client.subscribeTreeRoots('npub1example');
    await Promise.resolve();

    expect(updates).toEqual([
      {
        npub: 'npub1example',
        treeName: 'sites/example',
        ...ROOT_INFO,
      },
    ]);

    unsubscribe();
    await client.close();
  });

  it('registers media ports without waiting for a worker response', async () => {
    const worker = new FakeRelayWorker();
    const client = new RelayWorkerClient((class {
      constructor() {
        return worker;
      }
    }) as unknown as new () => Worker, {
      storeName: 'demo-sites-worker',
      relays: ['wss://relay.example'],
      blossomServers: [{ url: 'https://upload.example', read: false, write: true }],
      pubkey: '11'.repeat(32),
    });

    const { port1, port2 } = new MessageChannel();
    await client.registerMediaPort(port1, true);

    expect(worker.messages.at(-1)).toMatchObject({
      type: 'registerMediaPort',
      debug: true,
    });

    port2.close();
    await client.close();
  });
});
