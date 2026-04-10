import { describe, expect, it } from 'vitest';
import { HashtreeWorkerClient } from '../src/client.js';
import type { WorkerRequest, WorkerResponse } from '../src/protocol.js';

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  postMessage(message: WorkerRequest, _transfer?: Transferable[]): void {
    if (message.type === 'init') {
      this.emit({ type: 'ready', id: message.id });
      this.emit({
        type: 'diagnostic',
        event: {
          scope: 'media',
          code: 'port-registered',
          level: 'info',
          message: 'Registered media MessagePort',
          timestamp: 1700000000000,
          data: {
            requestId: null,
          },
        },
      });
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

describe('HashtreeWorkerClient diagnostics', () => {
  it('publishes optional diagnostic events from worker messages', async () => {
    const client = new HashtreeWorkerClient(FakeWorker as unknown as new () => Worker);
    const events: Array<{ scope: string; code: string; level: string }> = [];

    const unsubscribe = client.onDiagnostic((event) => {
      events.push({
        scope: event.scope,
        code: event.code,
        level: event.level,
      });
    });

    await client.init();

    expect(events).toContainEqual({
      scope: 'media',
      code: 'port-registered',
      level: 'info',
    });

    unsubscribe();
    await client.close();
  });
});
