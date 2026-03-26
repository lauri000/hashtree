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
      if (url === `${slowBase}/${hashHex}`) {
        return new Promise((resolve) => {
          resolveSlow = resolve;
        });
      }
      if (url === `${fastBase}/${hashHex}`) {
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
    expect(requestedUrls).toContain(`${slowBase}/${hashHex}`);
    expect(requestedUrls).toContain(`${fastBase}/${hashHex}`);

    resolveSlow?.({
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await expect(resultPromise).resolves.toEqual(data);
  });
});
