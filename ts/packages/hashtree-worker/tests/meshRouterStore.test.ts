import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, type Hash } from '@hashtree/core';
import { MeshRouterStore, type MeshReadSource } from '../src/capabilities/meshRouterStore.js';

const HASH_A = new Uint8Array(32).fill(1) as Hash;
const HASH_B = new Uint8Array(32).fill(2) as Hash;

function delayedSource(
  id: string,
  delayMs: number,
  value: Uint8Array | null,
  calls: { count: number },
): MeshReadSource {
  return {
    id,
    get: () => {
      calls.count += 1;
      return new Promise<Uint8Array | null>((resolve) => {
        setTimeout(() => resolve(value), delayMs);
      });
    },
  };
}

describe('MeshRouterStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('probes multiple unknown sources immediately so the fastest one wins', async () => {
    vi.useFakeTimers();
    const primary = new MemoryStore();
    const slowCalls = { count: 0 };
    const fastCalls = { count: 0 };
    const slowData = new Uint8Array([1]);
    const fastData = new Uint8Array([2]);
    const router = new MeshRouterStore({
      primary,
      primarySourceId: 'idb',
      requestTimeoutMs: 500,
      sources: [
        delayedSource('webrtc', 200, slowData, slowCalls),
        delayedSource('blossom', 50, fastData, fastCalls),
      ],
    });

    const pending = router.getDetailed(HASH_A);
    await Promise.resolve();

    expect(slowCalls.count).toBe(1);
    expect(fastCalls.count).toBe(1);

    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toEqual({ data: fastData, sourceId: 'blossom' });
    await expect(primary.get(HASH_A)).resolves.toEqual(fastData);
  });

  it('prefers the previously successful source before hedging to the slower one', async () => {
    vi.useFakeTimers();
    const primary = new MemoryStore();
    const peerCalls = { count: 0 };
    const blossomCalls = { count: 0 };
    const peerData = new Uint8Array([11]);
    const blossomData = new Uint8Array([22]);
    const router = new MeshRouterStore({
      primary,
      primarySourceId: 'idb',
      requestTimeoutMs: 500,
      sources: [
        delayedSource('webrtc', 20, peerData, peerCalls),
        delayedSource('blossom', 200, blossomData, blossomCalls),
      ],
    });

    const first = router.getDetailed(HASH_A);
    await Promise.resolve();
    expect(peerCalls.count).toBe(1);
    expect(blossomCalls.count).toBe(1);

    await vi.advanceTimersByTimeAsync(20);
    await expect(first).resolves.toEqual({ data: peerData, sourceId: 'webrtc' });

    const second = router.getDetailed(HASH_B);
    await Promise.resolve();

    expect(peerCalls.count).toBe(2);
    expect(blossomCalls.count).toBe(1);

    await vi.advanceTimersByTimeAsync(20);
    await expect(second).resolves.toEqual({ data: peerData, sourceId: 'webrtc' });
    expect(blossomCalls.count).toBe(1);
  });

  it('supports remote-only filtered reads without consulting primary storage', async () => {
    const primary = new MemoryStore();
    const localData = new Uint8Array([5]);
    const remoteData = new Uint8Array([9]);
    const blossomCalls = { count: 0 };
    await primary.put(HASH_A, localData);

    const router = new MeshRouterStore({
      primary,
      primarySourceId: 'idb',
      sources: [
        {
          id: 'blossom',
          get: async () => {
            blossomCalls.count += 1;
            return remoteData;
          },
        },
      ],
    });

    await expect(router.getDetailed(HASH_A)).resolves.toEqual({ data: localData, sourceId: 'idb' });
    await expect(router.getDetailed(HASH_A, {
      skipPrimary: true,
      sourceIds: ['blossom'],
    })).resolves.toEqual({ data: remoteData, sourceId: 'blossom' });
    expect(blossomCalls.count).toBe(1);
  });

  it('coalesces concurrent remote reads for the same hash and filter set', async () => {
    vi.useFakeTimers();
    const primary = new MemoryStore();
    let calls = 0;
    const data = new Uint8Array([77]);
    const router = new MeshRouterStore({
      primary,
      requestTimeoutMs: 500,
      sources: [
        {
          id: 'blossom',
          get: () => {
            calls += 1;
            return new Promise<Uint8Array | null>((resolve) => {
              setTimeout(() => resolve(data), 50);
            });
          },
        },
      ],
    });

    const first = router.getDetailed(HASH_A, { skipPrimary: true, sourceIds: ['blossom'] });
    const second = router.getDetailed(HASH_A, { skipPrimary: true, sourceIds: ['blossom'] });
    await Promise.resolve();

    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(50);
    await expect(first).resolves.toEqual({ data, sourceId: 'blossom' });
    await expect(second).resolves.toEqual({ data, sourceId: 'blossom' });
  });
});
