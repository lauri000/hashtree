import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlossomStore } from '../src/store/blossom.js';
import { sha256 } from '../src/hash.js';
import type { Hash } from '../src/types.js';

const DATA = new Uint8Array([1, 2, 3, 4, 5]);

async function makeHash(): Promise<Hash> {
  return await sha256(DATA) as Hash;
}

function makeResponse(status: number, body?: Uint8Array): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => (body ?? new Uint8Array()).buffer,
  } as Response;
}

describe('BlossomStore', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns the first successful read server instead of waiting in server order', async () => {
    vi.useFakeTimers();
    const hash = await makeHash();

    const fetchMock = vi.fn((input: string | URL | RequestInfo) => {
      const url = String(input);
      if (url.startsWith('https://slow.example/')) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(makeResponse(404)), 200);
        });
      }
      if (url.startsWith('https://fast.example/')) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(makeResponse(200, DATA)), 50);
        });
      }
      return Promise.resolve(makeResponse(404));
    });

    vi.stubGlobal('fetch', fetchMock);

    const store = new BlossomStore({
      servers: [
        { url: 'https://slow.example', read: true },
        { url: 'https://fast.example', read: true },
      ],
    });

    const readPromise = store.get(hash);
    await vi.advanceTimersByTimeAsync(50);

    await expect(readPromise).resolves.toEqual(DATA);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps waiting for a later success when another read server returns 404 first', async () => {
    vi.useFakeTimers();
    const hash = await makeHash();

    const fetchMock = vi.fn((input: string | URL | RequestInfo) => {
      const url = String(input);
      if (url.startsWith('https://missing.example/')) {
        return Promise.resolve(makeResponse(404));
      }
      if (url.startsWith('https://later.example/')) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(makeResponse(200, DATA)), 80);
        });
      }
      return Promise.resolve(makeResponse(404));
    });

    vi.stubGlobal('fetch', fetchMock);

    const store = new BlossomStore({
      servers: [
        { url: 'https://missing.example', read: true },
        { url: 'https://later.example', read: true },
      ],
    });

    const readPromise = store.get(hash);
    await vi.advanceTimersByTimeAsync(80);

    await expect(readPromise).resolves.toEqual(DATA);
  });
});
