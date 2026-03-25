import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cid, type CID } from '@hashtree/core';

const getLocalRootCache = vi.fn();
const getLocalRootKey = vi.fn();
const resolverResolve = vi.fn();
const ndkFetchEvent = vi.fn();
const npubToPubkey = vi.fn();
const querySync = vi.fn();
const closePool = vi.fn();
const destroyPool = vi.fn();

vi.mock('../src/treeRootCache', () => ({
  getLocalRootCache,
  getLocalRootKey,
}));

vi.mock('../src/refResolver', () => ({
  getRefResolver: () => ({
    resolve: resolverResolve,
  }),
}));

vi.mock('../src/nostr', () => ({
  ndk: {
    fetchEvent: ndkFetchEvent,
  },
  npubToPubkey,
}));

vi.mock('nostr-tools', () => ({
  SimplePool: vi.fn(function MockSimplePool() {
    return {
      querySync,
      close: closePool,
      destroy: destroyPool,
    };
  }),
}));

const ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
const ROOT_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 33);

describe('resolveFeedVideoRootCid', () => {
  beforeEach(() => {
    vi.resetModules();
    getLocalRootCache.mockReset();
    getLocalRootKey.mockReset();
    resolverResolve.mockReset();
    ndkFetchEvent.mockReset();
    npubToPubkey.mockReset();
    querySync.mockReset();
    closePool.mockReset();
    destroyPool.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an explicit root cid unchanged', async () => {
    const { resolveFeedVideoRootCid } = await import('../src/lib/videoFeedRoot');
    expect(resolveFeedVideoRootCid({
      rootCid: ROOT,
      ownerNpub: 'npub1example',
      treeName: 'videos/Music',
    })).toBe(ROOT);
  });

  it('resolves the root cid from the local tree cache when missing on the feed item', async () => {
    getLocalRootCache.mockReturnValue(ROOT.hash);
    getLocalRootKey.mockReturnValue(ROOT_KEY);

    const { resolveFeedVideoRootCid } = await import('../src/lib/videoFeedRoot');
    expect(resolveFeedVideoRootCid({
      ownerNpub: 'npub1example',
      treeName: 'videos/Music',
    })).toEqual(cid(ROOT.hash, ROOT_KEY));
  });

  it('falls back to the author tree event when mutable resolution misses', async () => {
    resolverResolve.mockResolvedValue(null);
    npubToPubkey.mockReturnValue('f'.repeat(64));
    ndkFetchEvent.mockResolvedValue({
      tags: [
        ['d', 'videos/Donkey Kong Country Soundtrack Full OST'],
        ['hash', '11'.repeat(32)],
        ['key', '22'.repeat(32)],
      ],
    });

    const { resolveFeedVideoRootCidAsync } = await import('../src/lib/videoFeedRoot');
    await expect(resolveFeedVideoRootCidAsync({
      ownerNpub: 'npub1example',
      treeName: 'videos/Donkey Kong Country Soundtrack Full OST',
    }, 1)).resolves.toEqual(cid(
      Uint8Array.from({ length: 32 }, () => 0x11),
      Uint8Array.from({ length: 32 }, () => 0x22),
    ));
    expect(ndkFetchEvent).toHaveBeenCalledWith({
      kinds: [30078],
      authors: ['f'.repeat(64)],
      '#d': ['videos/Donkey Kong Country Soundtrack Full OST'],
    }, { closeOnEose: true });
  });

  it('falls back to a raw relay query when mutable resolution and ndk fetch miss', async () => {
    resolverResolve.mockResolvedValue(null);
    npubToPubkey.mockReturnValue('f'.repeat(64));
    ndkFetchEvent.mockResolvedValue(null);
    querySync.mockResolvedValue(new Set([
      {
        created_at: 10,
        tags: [
          ['d', 'videos/Mine Bombers in-game music'],
          ['hash', '33'.repeat(32)],
        ],
      },
    ]));

    const { resolveFeedVideoRootCidAsync } = await import('../src/lib/videoFeedRoot');
    await expect(resolveFeedVideoRootCidAsync({
      ownerNpub: 'npub1example',
      treeName: 'videos/Mine Bombers in-game music',
    }, 1)).resolves.toEqual(cid(
      Uint8Array.from({ length: 32 }, () => 0x33),
    ));
    expect(querySync).toHaveBeenCalled();
    expect(closePool).toHaveBeenCalled();
    expect(destroyPool).toHaveBeenCalled();
  });

  it('avoids raw relay queries in native mode', async () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'htree:',
        hostname: 'npub1example',
        search: '',
      },
      __HTREE_SERVER_URL__: 'http://127.0.0.1:21417',
    });
    resolverResolve.mockResolvedValue(null);
    npubToPubkey.mockReturnValue('f'.repeat(64));
    ndkFetchEvent.mockResolvedValue(null);

    const { resolveFeedVideoRootCidAsync } = await import('../src/lib/videoFeedRoot');
    await expect(resolveFeedVideoRootCidAsync({
      ownerNpub: 'npub1example',
      treeName: 'videos/Mine Bombers in-game music',
    }, 1)).resolves.toBeNull();
    expect(querySync).not.toHaveBeenCalled();
  });
});
