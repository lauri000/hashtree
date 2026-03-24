import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cid, type CID } from '@hashtree/core';

const getLocalRootCache = vi.fn();
const getLocalRootKey = vi.fn();
const resolverResolve = vi.fn();
const ndkFetchEvent = vi.fn();
const npubToPubkey = vi.fn();

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
});
