import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cid, type CID } from '@hashtree/core';

const getLocalRootCache = vi.fn();
const getLocalRootKey = vi.fn();
const updateSubscriptionCache = vi.fn();
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

vi.mock('../src/stores/treeRoot', () => ({
  updateSubscriptionCache,
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
const LATEST_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => 200 - i) };

describe('resolveFeedVideoRootCid', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    getLocalRootCache.mockReset();
    getLocalRootKey.mockReset();
    resolverResolve.mockReset();
    updateSubscriptionCache.mockReset();
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

  it('prefers the cached mutable tree root over an explicit feed root', async () => {
    const STALE_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => 255 - i) };
    getLocalRootCache.mockReturnValue(ROOT.hash);
    getLocalRootKey.mockReturnValue(ROOT_KEY);

    const { resolveFeedVideoRootCid } = await import('../src/lib/videoFeedRoot');
    expect(resolveFeedVideoRootCid({
      rootCid: STALE_ROOT,
      ownerNpub: 'npub1example',
      treeName: 'videos/Music',
    })).toEqual(cid(ROOT.hash, ROOT_KEY));
  });

  it('falls back to the author tree event when mutable resolution misses', async () => {
    resolverResolve.mockResolvedValue(null);
    npubToPubkey.mockReturnValue('f'.repeat(64));
    ndkFetchEvent.mockResolvedValue({
      created_at: 42,
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
    expect(updateSubscriptionCache).toHaveBeenCalledWith(
      'npub1example/videos/Donkey Kong Country Soundtrack Full OST',
      Uint8Array.from({ length: 32 }, () => 0x11),
      Uint8Array.from({ length: 32 }, () => 0x22),
      { updatedAt: 42, visibility: 'public' },
    );
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
    expect(updateSubscriptionCache).toHaveBeenCalledWith(
      'npub1example/videos/Mine Bombers in-game music',
      Uint8Array.from({ length: 32 }, () => 0x33),
      undefined,
      { updatedAt: 10, visibility: 'public' },
    );
  });

  it('starts ndk fallback immediately when the resolver hangs', async () => {
    resolverResolve.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(ROOT), 20);
    }));
    npubToPubkey.mockReturnValue('f'.repeat(64));
    ndkFetchEvent.mockResolvedValue({
      created_at: 12,
      tags: [
        ['d', 'videos/Resolver Hang'],
        ['hash', '55'.repeat(32)],
      ],
    });

    const { resolveFeedVideoRootCidAsync } = await import('../src/lib/videoFeedRoot');
    const resultPromise = resolveFeedVideoRootCidAsync({
      ownerNpub: 'npub1example',
      treeName: 'videos/Resolver Hang',
    }, 1000);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ndkFetchEvent).toHaveBeenCalledWith({
      kinds: [30078],
      authors: ['f'.repeat(64)],
      '#d': ['videos/Resolver Hang'],
    }, { closeOnEose: true });

    await expect(resultPromise).resolves.toEqual(cid(
      Uint8Array.from({ length: 32 }, () => 0x55),
    ));
  });

  it('prefers an authoritative tree event over a speculative resolver root when requested', async () => {
    resolverResolve.mockResolvedValue(ROOT);
    npubToPubkey.mockReturnValue('f'.repeat(64));
    ndkFetchEvent.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        created_at: 99,
        tags: [
          ['d', 'videos/Remember this'],
          ['hash', '66'.repeat(32)],
        ],
      };
    });

    const { resolveFeedVideoRootCidAsync } = await import('../src/lib/videoFeedRoot');
    await expect(resolveFeedVideoRootCidAsync({
      ownerNpub: 'npub1example',
      treeName: 'videos/Remember this',
    }, 1000, {
      requireAuthoritative: true,
      authoritativeGraceMs: 50,
    })).resolves.toEqual(cid(
      Uint8Array.from({ length: 32 }, () => 0x66),
    ));
  });

  it('coalesces concurrent async root resolution for the same feed tree', async () => {
    let resolveRoot: ((value: CID | null) => void) | null = null;
    resolverResolve.mockImplementation(() => new Promise((resolve) => {
      resolveRoot = resolve as (value: CID | null) => void;
    }));

    const { resolveFeedVideoRootCidAsync } = await import('../src/lib/videoFeedRoot');
    const first = resolveFeedVideoRootCidAsync({
      ownerNpub: 'npub1example',
      treeName: 'videos/Remember this',
    }, 1000);
    const second = resolveFeedVideoRootCidAsync({
      ownerNpub: 'npub1example',
      treeName: 'videos/Remember this',
    }, 1000);

    await vi.waitFor(() => {
      expect(resolverResolve).toHaveBeenCalledTimes(1);
    });

    resolveRoot?.(ROOT);

    await expect(first).resolves.toEqual(ROOT);
    await expect(second).resolves.toEqual(ROOT);
    expect(updateSubscriptionCache).not.toHaveBeenCalled();
  });

  it('does not cache speculative resolver roots across lookups', async () => {
    resolverResolve.mockResolvedValueOnce(ROOT).mockResolvedValueOnce(LATEST_ROOT);

    const { resolveFeedVideoRootCidAsync } = await import('../src/lib/videoFeedRoot');
    await expect(resolveFeedVideoRootCidAsync({
      ownerNpub: 'npub1example',
      treeName: 'videos/Remember this',
    }, 1000)).resolves.toEqual(ROOT);
    await expect(resolveFeedVideoRootCidAsync({
      ownerNpub: 'npub1example',
      treeName: 'videos/Remember this',
    }, 1000)).resolves.toEqual(LATEST_ROOT);
    expect(resolverResolve).toHaveBeenCalledTimes(2);
  });

  it('falls back to the explicit feed root when mutable resolution misses', async () => {
    resolverResolve.mockResolvedValue(null);
    npubToPubkey.mockReturnValue('f'.repeat(64));
    ndkFetchEvent.mockResolvedValue(null);
    querySync.mockResolvedValue(new Set());

    const { resolveFeedVideoRootCidAsync } = await import('../src/lib/videoFeedRoot');
    await expect(resolveFeedVideoRootCidAsync({
      rootCid: ROOT,
      ownerNpub: 'npub1example',
      treeName: 'videos/Remember this',
    }, 1)).resolves.toEqual(ROOT);
    expect(updateSubscriptionCache).not.toHaveBeenCalledWith(
      'npub1example/videos/Remember this',
      ROOT.hash,
      ROOT.key,
      expect.anything(),
    );
  });

  it('still falls back to raw relay queries in native mode when earlier resolution misses', async () => {
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
    querySync.mockResolvedValue(new Set([
      {
        created_at: 10,
        tags: [
          ['d', 'videos/Mine Bombers in-game music'],
          ['hash', '44'.repeat(32)],
        ],
      },
    ]));

    const { resolveFeedVideoRootCidAsync } = await import('../src/lib/videoFeedRoot');
    await expect(resolveFeedVideoRootCidAsync({
      ownerNpub: 'npub1example',
      treeName: 'videos/Mine Bombers in-game music',
    }, 1)).resolves.toEqual(cid(
      Uint8Array.from({ length: 32 }, () => 0x44),
    ));
    expect(querySync).toHaveBeenCalled();
  });
});
