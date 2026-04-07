import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CID } from '@hashtree/core';

const resolveRootPathFromRelaysMock = vi.hoisted(() => vi.fn());
const watchRootPathFromRelaysMock = vi.hoisted(() => vi.fn());
const postMessageMock = vi.hoisted(() => vi.fn());
const closeWatchMock = vi.hoisted(() => vi.fn());

const ROOT: CID = {
  hash: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
};

class FakeHashTree {
  constructor(_config: unknown) {}
}

class FakeIdbBlobStorage {
  constructor(_storeName: string, _maxBytes: number) {}

  close(): void {}

  setMaxBytes(_maxBytes: number): void {}

  async getStats(): Promise<{ items: number; bytes: number; maxBytes: number }> {
    return { items: 0, bytes: 0, maxBytes: 0 };
  }

  async get(_hashHex: string): Promise<Uint8Array | null> {
    return null;
  }

  async has(_hashHex: string): Promise<boolean> {
    return false;
  }

  async delete(_hashHex: string): Promise<boolean> {
    return false;
  }

  async putByHashTrusted(_hashHex: string, _data: Uint8Array): Promise<void> {}
}

class FakeBlossomTransport {
  constructor(_servers: unknown, _onBandwidthUpdate?: (stats: unknown) => void) {}

  getBandwidthStats(): { totalBytesSent: number; totalBytesReceived: number; updatedAt: number; servers: [] } {
    return {
      totalBytesSent: 0,
      totalBytesReceived: 0,
      updatedAt: 0,
      servers: [],
    };
  }

  getServers(): [] {
    return [];
  }

  setServers(_servers: unknown): void {}
}

vi.mock('@hashtree/core', () => ({
  HashTree: FakeHashTree,
  decryptChk: vi.fn(),
  nhashDecode: vi.fn(),
  nhashEncode: vi.fn(),
  toHex: vi.fn(),
  tryDecodeTreeNode: vi.fn(),
}));

vi.mock('../src/capabilities/idbStorage.js', () => ({
  IdbBlobStorage: FakeIdbBlobStorage,
}));

vi.mock('../src/capabilities/blossomTransport.js', () => ({
  BlossomTransport: FakeBlossomTransport,
  DEFAULT_BLOSSOM_SERVERS: [],
}));

vi.mock('../src/capabilities/connectivity.js', () => ({
  probeConnectivity: vi.fn().mockResolvedValue({
    online: true,
    reachableReadServers: 0,
    totalReadServers: 0,
    reachableWriteServers: 0,
    totalWriteServers: 0,
    updatedAt: 0,
  }),
}));

vi.mock('../src/capabilities/rootResolver.js', () => ({
  resolveRootPathFromRelays: resolveRootPathFromRelaysMock,
  watchRootPathFromRelays: watchRootPathFromRelaysMock,
}));

vi.mock('../src/privacyGuards.js', () => ({
  assertEncryptedUploadCid: vi.fn(),
  markEncryptedHashes: vi.fn(),
  shouldServeHashToPeer: vi.fn(() => true),
}));

vi.mock('../src/mediaStreaming.js', () => ({
  streamFileRangeChunks: vi.fn(),
}));

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('worker root resolution message flow', () => {
  beforeEach(() => {
    vi.resetModules();
    resolveRootPathFromRelaysMock.mockReset();
    watchRootPathFromRelaysMock.mockReset();
    closeWatchMock.mockReset();
    postMessageMock.mockReset();
    Object.defineProperty(globalThis, 'self', {
      configurable: true,
      writable: true,
      value: {
        postMessage: postMessageMock,
        onmessage: null,
      },
    });
  });

  afterEach(() => {
    // @ts-expect-error test cleanup
    delete globalThis.self;
  });

  it('routes resolveRoot requests through the worker protocol', async () => {
    resolveRootPathFromRelaysMock.mockResolvedValue(ROOT);
    await import('../src/worker.js');

    const ctx = globalThis.self as {
      onmessage: ((event: { data: unknown }) => void) | null;
    };

    ctx.onmessage?.({
      data: {
        type: 'init',
        id: 'init-1',
        config: {
          relays: ['wss://relay.example'],
        },
      },
    });
    await flush();

    ctx.onmessage?.({
      data: {
        type: 'resolveRoot',
        id: 'resolve-1',
        npub: 'npub1example',
        path: 'audio-catalog/root.json',
        timeoutMs: 4_500,
        settleMs: 500,
      },
    });
    await flush();

    expect(resolveRootPathFromRelaysMock).toHaveBeenCalledWith(
      expect.any(FakeHashTree),
      ['wss://relay.example'],
      'npub1example',
      'audio-catalog/root.json',
      4_500,
      500,
    );
    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'cid',
      id: 'resolve-1',
      cid: ROOT,
    });
  });

  it('starts, emits, and stops root watches through the worker protocol', async () => {
    watchRootPathFromRelaysMock.mockResolvedValue({
      initialCid: ROOT,
      close: closeWatchMock,
    });
    await import('../src/worker.js');

    const ctx = globalThis.self as {
      onmessage: ((event: { data: unknown }) => void) | null;
    };

    ctx.onmessage?.({
      data: {
        type: 'init',
        id: 'init-2',
        config: {
          relays: ['wss://relay.example'],
        },
      },
    });
    await flush();

    ctx.onmessage?.({
      data: {
        type: 'watchRoot',
        id: 'watch-1',
        npub: 'npub1example',
        path: 'audio-catalog/root.json',
        timeoutMs: 4_500,
        settleMs: 500,
      },
    });
    await flush();

    const started = postMessageMock.mock.calls
      .map((call) => call[0] as { type?: string; watchId?: string })
      .find((message) => message.type === 'rootWatchStarted');
    expect(started?.watchId).toBeTruthy();

    const onUpdate = watchRootPathFromRelaysMock.mock.calls[0]?.[4] as ((cid: CID | null) => void) | undefined;
    expect(onUpdate).toBeTypeOf('function');
    onUpdate?.(null);
    await flush();

    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'rootUpdate',
      watchId: started!.watchId,
      cid: undefined,
    });

    ctx.onmessage?.({
      data: {
        type: 'unwatchRoot',
        id: 'unwatch-1',
        watchId: started!.watchId,
      },
    });
    await flush();

    expect(closeWatchMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'void',
      id: 'unwatch-1',
    });
  });
});
