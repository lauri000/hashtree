import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachHashtreeWorker, type HashtreeWorkerMessageEndpoint } from '../src/worker';

class FakeWorkerEndpoint implements HashtreeWorkerMessageEndpoint {
  readonly responses: unknown[] = [];
  started = 0;
  private readonly listeners = new Set<EventListener>();

  addEventListener(_type: 'message', listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === 'function') {
      this.listeners.add(listener);
      return;
    }
    this.listeners.add(listener.handleEvent.bind(listener) as EventListener);
  }

  removeEventListener(_type: 'message', listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === 'function') {
      this.listeners.delete(listener);
      return;
    }
    this.listeners.delete(listener.handleEvent.bind(listener) as EventListener);
  }

  postMessage(message: unknown): void {
    this.responses.push(message);
  }

  start(): void {
    this.started += 1;
  }

  dispatch(data: unknown): void {
    const event = { data } as MessageEvent<unknown>;
    for (const listener of this.listeners) {
      listener(event as unknown as Event);
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachHashtreeWorker', () => {
  it('handles protocol messages without owning the whole worker global', async () => {
    const endpoint = new FakeWorkerEndpoint();
    const detach = attachHashtreeWorker(endpoint);

    expect(endpoint.started).toBe(1);

    endpoint.dispatch({ custom: true });
    await flushMicrotasks();
    expect(endpoint.responses).toEqual([]);

    endpoint.dispatch({ type: 'close', id: 'req-1' });
    await vi.waitFor(() => {
      expect(endpoint.responses).toContainEqual({ type: 'void', id: 'req-1' });
    });

    detach();
    endpoint.responses.length = 0;
    endpoint.dispatch({ type: 'close', id: 'req-2' });
    await flushMicrotasks();
    expect(endpoint.responses).toEqual([]);
  });
});
