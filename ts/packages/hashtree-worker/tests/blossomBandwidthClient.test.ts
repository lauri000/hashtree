import { describe, expect, it } from 'vitest';
import { HashtreeWorkerClient } from '../src/client.js';
import type { WorkerRequest, WorkerResponse } from '../src/protocol.js';

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  postMessage(message: WorkerRequest, _transfer?: Transferable[]): void {
    if (message.type === 'init') {
      this.emit({ type: 'ready', id: message.id });
      // Emit a bandwidth update after init to simulate worker push message.
      this.emit({
        type: 'blossomBandwidth',
        stats: {
          totalBytesSent: 1024,
          totalBytesReceived: 2048,
          updatedAt: 1700000000000,
          servers: [
            { url: 'https://upload.iris.to', bytesSent: 1024, bytesReceived: 0 },
            { url: 'https://blossom.primal.net', bytesSent: 0, bytesReceived: 2048 },
          ],
        },
      } as WorkerResponse);
      return;
    }

    if (message.type === 'close') {
      this.emit({ type: 'void', id: message.id });
      return;
    }
  }

  terminate(): void {
    // no-op
  }

  private emit(message: WorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }
}

describe('HashtreeWorkerClient blossom bandwidth', () => {
  it('publishes blossom bandwidth updates from worker messages', async () => {
    const client = new HashtreeWorkerClient(FakeWorker as unknown as new () => Worker);
    const updates: Array<{ sent: number; received: number; servers: number }> = [];

    const unsubscribe = client.onBlossomBandwidth((stats) => {
      updates.push({
        sent: stats.totalBytesSent,
        received: stats.totalBytesReceived,
        servers: stats.servers.length,
      });
    });

    await client.init();

    expect(updates).toContainEqual({ sent: 1024, received: 2048, servers: 2 });

    unsubscribe();
    await client.close();
  });
});
