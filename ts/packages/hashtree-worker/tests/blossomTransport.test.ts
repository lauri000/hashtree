import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlossomTransport } from '../src/capabilities/blossomTransport.js';
import { sha256, toHex } from '@hashtree/core';

describe('BlossomTransport.fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queries read servers in parallel so a stalled first server does not block a fast second server', async () => {
    const data = new TextEncoder().encode('parallel-blossom-thumb');
    const hashHex = toHex(await sha256(data));
    const slowBase = 'https://slow.example';
    const fastBase = 'https://fast.example';

    let resolveSlow: ((value: unknown) => void) | null = null;
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === `${slowBase}/${hashHex}.bin`) {
        return new Promise((resolve) => {
          resolveSlow = resolve;
        });
      }
      if (url === `${fastBase}/${hashHex}.bin`) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => data.buffer.slice(0),
        });
      }
      return Promise.resolve({
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new BlossomTransport([
      { url: slowBase, read: true, write: false },
      { url: fastBase, read: true, write: false },
    ]);

    const resultPromise = transport.fetch(hashHex);
    await Promise.resolve();
    await Promise.resolve();

    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestedUrls).toContain(`${slowBase}/${hashHex}.bin`);
    expect(requestedUrls).toContain(`${fastBase}/${hashHex}.bin`);

    resolveSlow?.({
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await expect(resultPromise).resolves.toEqual(data);
  });

  it('deduplicates concurrent fetches for the same hash', async () => {
    const data = new TextEncoder().encode('dedupe-blossom-thumb');
    const hashHex = toHex(await sha256(data));
    const base = 'https://fast.example';

    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url !== `${base}/${hashHex}.bin`) {
        return Promise.resolve({
          ok: false,
          arrayBuffer: async () => new ArrayBuffer(0),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => data.buffer.slice(0),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new BlossomTransport([
      { url: base, read: true, write: false },
    ]);

    const first = transport.fetch(hashHex);
    const second = transport.fetch(hashHex);

    await expect(Promise.all([first, second])).resolves.toEqual([data, data]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('limits concurrent read fetches across hashes', async () => {
    const base = 'https://throttled.example';
    const hashes = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(64, '0'));
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;

    const fetchMock = vi.fn(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve({
            ok: false,
            status: 404,
            arrayBuffer: async () => new ArrayBuffer(0),
          });
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new BlossomTransport([
      { url: base, read: true, write: false },
    ]);

    const requests = hashes.map((hashHex) => transport.fetch(hashHex));

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(maxActive).toBe(12);

    while (fetchMock.mock.calls.length < hashes.length || active > 0) {
      const batch = releases.splice(0, releases.length);
      if (batch.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      for (const release of batch) {
        release();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await expect(Promise.all(requests)).resolves.toEqual(Array(hashes.length).fill(null));
    expect(maxActive).toBeLessThanOrEqual(12);
  });

  it('reuses BlossomStore backoff so failed servers are skipped on immediate retries', async () => {
    const data = new TextEncoder().encode('backoff-blossom-thumb');
    const hashHex = toHex(await sha256(data));
    const slowBase = 'https://slow.example';
    const fastBase = 'https://fast.example';
    let fastCalls = 0;

    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === `${slowBase}/${hashHex}.bin`) {
        return Promise.reject(new Error('slow server offline'));
      }
      if (url === `${fastBase}/${hashHex}.bin`) {
        fastCalls += 1;
        if (fastCalls === 1) {
          return Promise.resolve({
            ok: false,
            status: 404,
            arrayBuffer: async () => new ArrayBuffer(0),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: async () => data.buffer.slice(0),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new BlossomTransport([
      { url: slowBase, read: true, write: false },
      { url: fastBase, read: true, write: false },
    ]);

    await expect(transport.fetch(hashHex)).resolves.toBeNull();
    await expect(transport.fetch(hashHex)).resolves.toEqual(data);

    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.filter((url) => url === `${slowBase}/${hashHex}.bin`)).toHaveLength(1);
    expect(requestedUrls.filter((url) => url === `${fastBase}/${hashHex}.bin`)).toHaveLength(2);
  });
});
