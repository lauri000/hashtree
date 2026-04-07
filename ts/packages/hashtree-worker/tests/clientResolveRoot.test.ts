import { describe, expect, it } from 'vitest';
import type { CID } from '@hashtree/core';
import { HashtreeWorkerClient } from '../src/client.js';
import type { WorkerRequest, WorkerResponse } from '../src/protocol.js';

const ROOT: CID = {
  hash: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
};

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private watchId = 'watch-1';

  postMessage(message: WorkerRequest, _transfer?: Transferable[]): void {
    if (message.type === 'init') {
      this.emit({ type: 'ready', id: message.id });
      return;
    }

    if (message.type === 'resolveRoot') {
      this.emit({ type: 'cid', id: message.id, cid: ROOT });
      return;
    }

    if (message.type === 'watchRoot') {
      this.emit({ type: 'rootWatchStarted', id: message.id, watchId: this.watchId, cid: ROOT });
      queueMicrotask(() => {
        this.emit({ type: 'rootUpdate', watchId: this.watchId });
      });
      return;
    }

    if (message.type === 'unwatchRoot') {
      this.emit({ type: 'void', id: message.id });
      return;
    }

    if (message.type === 'close') {
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

describe('HashtreeWorkerClient resolveRoot', () => {
  it('returns CID results from the worker', async () => {
    const client = new HashtreeWorkerClient(FakeWorker as unknown as new () => Worker);
    await expect(client.resolveRoot('npub1example', 'audio-catalog/root.json')).resolves.toEqual(ROOT);
    await client.close();
  });

  it('streams root updates from the worker', async () => {
    const client = new HashtreeWorkerClient(FakeWorker as unknown as new () => Worker);
    const updates: Array<CID | null> = [];
    const unwatch = await client.watchRoot('npub1example', 'audio-catalog/root.json', (cid) => {
      updates.push(cid);
    });

    await Promise.resolve();

    expect(updates).toEqual([ROOT, null]);

    await unwatch();
    await client.close();
  });
});
