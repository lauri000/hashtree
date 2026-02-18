import { afterEach, describe, expect, it, vi } from 'vitest';
import { HashtreeWorkerClient } from '../src/client.js';
import type { WorkerRequest, WorkerResponse } from '../src/protocol.js';

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private streamCounter = 0;

  postMessage(message: WorkerRequest, _transfer?: Transferable[]): void {
    if (message.type === 'init') {
      this.emit({ type: 'ready', id: message.id });
      return;
    }

    if (message.type === 'beginPutBlobStream') {
      this.streamCounter += 1;
      this.emit({ type: 'blobStreamStarted', id: message.id, streamId: `stream-${this.streamCounter}` });
      return;
    }

    if (message.type === 'appendPutBlobStream' || message.type === 'cancelPutBlobStream') {
      this.emit({ type: 'void', id: message.id });
      return;
    }

    if (message.type === 'finishPutBlobStream') {
      this.emit({ type: 'blobStored', id: message.id, hashHex: 'abc', nhash: 'nhash1abc' });
      return;
    }

    if (message.type === 'close') {
      this.emit({ type: 'void', id: message.id });
    }
  }

  terminate(): void {
    // no-op for tests
  }

  private emit(message: WorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }
}

describe('HashtreeWorkerClient timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not timeout putBlob at the default request timeout window', async () => {
    vi.useFakeTimers();
    const client = new HashtreeWorkerClient(FakeWorker as unknown as new () => Worker);

    let putError: Error | undefined;
    void client.putBlob(new Uint8Array([1, 2, 3]), 'application/octet-stream', false).catch((err) => {
      putError = err as Error;
    });

    await vi.advanceTimersByTimeAsync(30_001);
    expect(putError).toBeUndefined();

    await vi.runOnlyPendingTimersAsync();
    expect(putError?.message).toContain('Worker request timed out: putBlob');

    await client.close();
  });

  it('keeps default timeout for other requests like getBlob', async () => {
    vi.useFakeTimers();
    const client = new HashtreeWorkerClient(FakeWorker as unknown as new () => Worker);

    let getError: Error | undefined;
    void client.getBlob('deadbeef').catch((err) => {
      getError = err as Error;
    });

    await vi.advanceTimersByTimeAsync(30_001);
    expect(getError?.message).toContain('Worker request timed out: getBlob');

    await client.close();
  });

  it('supports streamed putBlob lifecycle', async () => {
    const client = new HashtreeWorkerClient(FakeWorker as unknown as new () => Worker);
    const streamId = await client.beginPutBlobStream('application/octet-stream');
    expect(streamId).toBe('stream-1');

    await client.appendPutBlobStream(streamId, new Uint8Array([1, 2, 3]));
    const stored = await client.finishPutBlobStream(streamId);
    expect(stored).toEqual({ hashHex: 'abc', nhash: 'nhash1abc' });

    await client.cancelPutBlobStream(streamId);
    await client.close();
  });
});
