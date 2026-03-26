import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CID } from '@hashtree/core';
import type { FeedVideo } from '../src/stores/feedStore';

const detectPlaylistForCard = vi.fn();
const getCachedPlaylistInfo = vi.fn();
const getLocalRootCache = vi.fn();
const getLocalRootKey = vi.fn();
const resolverResolve = vi.fn();
const ndkFetchEvent = vi.fn();
const npubToPubkey = vi.fn();
const pubkeyToNpub = vi.fn();
const resolveReadableVideoRoot = vi.fn();
const resolveReadableThumbnailRoot = vi.fn();
const cacheListeners: Array<(npub: string, treeName: string) => void> = [];

vi.mock('../src/stores/playlist', () => ({
  detectPlaylistForCard,
  getCachedPlaylistInfo,
  shouldRefreshPlaylistCardInfo: (info: { thumbnailUrl?: string } | null | undefined) => !!info && !info.thumbnailUrl,
}));

vi.mock('../src/treeRootCache', () => ({
  getLocalRootCache,
  getLocalRootKey,
  onCacheUpdate: (listener: (npub: string, treeName: string) => void) => {
    cacheListeners.push(listener);
    return () => {
      const index = cacheListeners.indexOf(listener);
      if (index !== -1) cacheListeners.splice(index, 1);
    };
  },
}));

vi.mock('../src/refResolver', () => ({
  getRefResolver: () => ({
    resolve: resolverResolve,
  }),
}));

vi.mock('../src/lib/readableVideoRoot', () => ({
  resolveReadableVideoRoot,
  resolveReadableThumbnailRoot,
}));

vi.mock('../src/nostr', () => ({
  ndk: {
    fetchEvent: ndkFetchEvent,
  },
  npubToPubkey,
  pubkeyToNpub,
  nostrStore: {
    subscribe: () => () => {},
    get pubkey() {
      return null;
    },
  },
}));

const ROOT: CID = { hash: new Uint8Array(32) };

async function flushAsyncUpdates(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe('getFeedVideoResolvedMedia', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    detectPlaylistForCard.mockReset();
    getCachedPlaylistInfo.mockReset();
    getLocalRootCache.mockReset();
    getLocalRootKey.mockReset();
    resolverResolve.mockReset();
    ndkFetchEvent.mockReset();
    npubToPubkey.mockReset();
    pubkeyToNpub.mockReset();
    resolveReadableVideoRoot.mockReset();
    resolveReadableThumbnailRoot.mockReset();
    cacheListeners.length = 0;
    ndkFetchEvent.mockResolvedValue(null);
    npubToPubkey.mockReturnValue(null);
    pubkeyToNpub.mockImplementation((value: string) => value);
    resolveReadableVideoRoot.mockImplementation(async ({ rootCid }: { rootCid?: CID | null }) => rootCid ?? null);
    resolveReadableThumbnailRoot.mockImplementation(async ({ rootCid }: { rootCid?: CID | null }) => rootCid ?? null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses cached exact thumbnail info when available', async () => {
    getCachedPlaylistInfo.mockReturnValue({
      videoCount: 2,
      thumbnailUrl: '/htree/nhash1cached/thumbnail.webp',
    });

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FMusic',
      title: 'Music',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Music',
      rootCid: ROOT,
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      thumbnailUrl: '/htree/nhash1cached/thumbnail.webp',
    });
    expect(detectPlaylistForCard).not.toHaveBeenCalled();
  });

  it('detects exact thumbnail and metadata from htree when not cached', async () => {
    getCachedPlaylistInfo.mockReturnValue(undefined);
    detectPlaylistForCard.mockResolvedValue({
      videoCount: 0,
      thumbnailUrl: '/htree/nhash1detected/thumbnail.jpg',
      duration: 187,
      title: 'Detected title',
    });

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FDetected',
      title: 'Detected',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Detected',
      rootCid: ROOT,
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      thumbnailUrl: '/htree/nhash1detected/thumbnail.jpg',
      duration: 187,
      title: 'Detected title',
    });
    expect(detectPlaylistForCard).toHaveBeenCalledWith(ROOT, 'npub1example', 'videos/Detected');
  });

  it('refreshes cached playlist info that is missing a thumbnail url', async () => {
    getCachedPlaylistInfo.mockReturnValue({
      videoCount: 2,
      duration: 120,
      title: 'Stale title',
    });
    detectPlaylistForCard.mockResolvedValue({
      videoCount: 2,
      thumbnailUrl: '/htree/nhash1refreshed/thumbnail.jpg',
      duration: 120,
      title: 'Refreshed title',
    });

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FStale',
      title: 'Stale',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Stale',
      rootCid: ROOT,
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      thumbnailUrl: '/htree/nhash1refreshed/thumbnail.jpg',
      duration: 120,
      title: 'Refreshed title',
    });
    expect(detectPlaylistForCard).toHaveBeenCalledWith(ROOT, 'npub1example', 'videos/Stale');
  });

  it('resolves social feed videos from the local root cache when rootCid is missing', async () => {
    getLocalRootCache.mockReturnValue(ROOT.hash);
    getLocalRootKey.mockReturnValue(undefined);
    getCachedPlaylistInfo.mockReturnValue(undefined);
    detectPlaylistForCard.mockResolvedValue({
      videoCount: 0,
      thumbnailUrl: '/htree/nhash1local/thumbnail.jpg',
      duration: 77,
      title: 'Local root title',
    });

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FLocal%20Root',
      title: 'Local Root',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Local Root',
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      rootCid: ROOT,
      thumbnailUrl: '/htree/nhash1local/thumbnail.jpg',
      duration: 77,
      title: 'Local root title',
    });
    expect(detectPlaylistForCard).toHaveBeenCalledWith(ROOT, 'npub1example', 'videos/Local Root');
  });

  it('prefers the latest local tree root over a stale feed root cid', async () => {
    const STALE_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, () => 0xaa) };
    getLocalRootCache.mockReturnValue(ROOT.hash);
    getLocalRootKey.mockReturnValue(undefined);
    getCachedPlaylistInfo.mockReturnValue(undefined);
    detectPlaylistForCard.mockResolvedValue({
      videoCount: 0,
      thumbnailUrl: '/htree/nhash1current/thumbnail.jpg',
      duration: 91,
      title: 'Current root title',
    });

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FCurrent%20Root',
      title: 'Current Root',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Current Root',
      rootCid: STALE_ROOT,
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      rootCid: ROOT,
      thumbnailUrl: '/htree/nhash1current/thumbnail.jpg',
      duration: 91,
      title: 'Current root title',
    });
    expect(detectPlaylistForCard).toHaveBeenCalledWith(ROOT, 'npub1example', 'videos/Current Root');
  });

  it('retries transient htree misses until exact feed media resolves', async () => {
    vi.useFakeTimers();
    getCachedPlaylistInfo.mockReturnValue(undefined);
    detectPlaylistForCard
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        videoCount: 0,
        thumbnailUrl: '/htree/nhash1retry/thumbnail.jpg',
        duration: 93,
      });

    const { feedStore, setFeedVideos } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FRetry',
      title: 'Retry',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Retry',
      rootCid: ROOT,
    };

    let currentVideos: FeedVideo[] = [];
    const unsubscribe = feedStore.subscribe((value) => {
      currentVideos = value;
    });

    setFeedVideos([video]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    expect(detectPlaylistForCard).toHaveBeenCalledTimes(2);
    expect(currentVideos).toHaveLength(1);
    expect(currentVideos[0]).toMatchObject({
      thumbnailUrl: '/htree/nhash1retry/thumbnail.jpg',
      duration: 93,
    });

    unsubscribe();
  });

  it('does not bypass a scheduled media retry when repeated raw feed flushes arrive', async () => {
    vi.useFakeTimers();
    getCachedPlaylistInfo.mockReturnValue(undefined);
    detectPlaylistForCard.mockResolvedValue(null);

    const { setFeedVideos } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FIdle',
      title: 'Idle',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Idle',
      rootCid: ROOT,
    };

    setFeedVideos([video]);
    await flushAsyncUpdates();
    expect(detectPlaylistForCard).toHaveBeenCalledTimes(1);

    setFeedVideos([video]);
    await flushAsyncUpdates();
    setFeedVideos([video]);
    await flushAsyncUpdates();
    expect(detectPlaylistForCard).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(detectPlaylistForCard).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(detectPlaylistForCard).toHaveBeenCalledTimes(2);
  });

  it('falls back to resolver lookups when a social feed video is not yet in local root cache', async () => {
    getCachedPlaylistInfo.mockReturnValue(undefined);
    resolverResolve.mockResolvedValue(ROOT);
    detectPlaylistForCard.mockResolvedValue({
      videoCount: 0,
      thumbnailUrl: '/htree/nhash1resolver/thumbnail.jpg',
      duration: 88,
      title: 'Resolver title',
    });

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FResolver',
      title: 'Resolver',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Resolver',
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      rootCid: ROOT,
      thumbnailUrl: '/htree/nhash1resolver/thumbnail.jpg',
      duration: 88,
      title: 'Resolver title',
    });
    expect(resolverResolve).toHaveBeenCalledWith('npub1example/videos/Resolver');
  });

  it('keeps a readable fallback root even when thumbnail detection still returns empty', async () => {
    const FALLBACK_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, () => 0x44) };
    getCachedPlaylistInfo.mockReturnValue(undefined);
    resolveReadableVideoRoot.mockResolvedValue(FALLBACK_ROOT);
    detectPlaylistForCard.mockResolvedValue(null);

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FRemember%20this',
      title: 'Remember this',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Remember this',
      rootCid: ROOT,
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      rootCid: FALLBACK_ROOT,
    });
    expect(detectPlaylistForCard).toHaveBeenCalledWith(FALLBACK_ROOT, 'npub1example', 'videos/Remember this');
  });

  it('keeps a resolved thumbnail from a historical thumbnail root even when current card info is empty', async () => {
    const THUMBNAIL_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, () => 0x45) };
    getCachedPlaylistInfo.mockReturnValue(undefined);
    resolveReadableThumbnailRoot.mockResolvedValue(THUMBNAIL_ROOT);
    detectPlaylistForCard
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        videoCount: 0,
        rootCid: THUMBNAIL_ROOT,
        thumbnailUrl: '/htree/nhash1historic/thumbnail.jpg',
      });

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FRemember%20this',
      title: 'Remember this',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Remember this',
      rootCid: ROOT,
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      thumbnailUrl: '/htree/nhash1historic/thumbnail.jpg',
    });
    expect(detectPlaylistForCard).toHaveBeenNthCalledWith(1, ROOT, 'npub1example', 'videos/Remember this');
    expect(detectPlaylistForCard).toHaveBeenNthCalledWith(
      2,
      THUMBNAIL_ROOT,
      'npub1example',
      'videos/Remember this',
      { cacheScope: 'root' },
    );
  });

  it('backfills feed thumbnails from a historical thumbnail-rich root without changing playback root', async () => {
    const THUMBNAIL_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, () => 0x55) };
    getCachedPlaylistInfo.mockReturnValue(undefined);
    resolveReadableThumbnailRoot.mockResolvedValue(THUMBNAIL_ROOT);
    detectPlaylistForCard
      .mockResolvedValueOnce({
        videoCount: 0,
        rootCid: ROOT,
        duration: 44,
        title: 'Current root title',
      })
      .mockResolvedValueOnce({
        videoCount: 0,
        rootCid: THUMBNAIL_ROOT,
        thumbnailUrl: '/htree/nhash1historic/thumbnail.jpg',
      });

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FDonkey',
      title: 'Donkey',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Donkey',
      rootCid: ROOT,
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      thumbnailUrl: '/htree/nhash1historic/thumbnail.jpg',
      duration: 44,
      title: 'Current root title',
    });
    expect(detectPlaylistForCard).toHaveBeenNthCalledWith(1, ROOT, 'npub1example', 'videos/Donkey');
    expect(detectPlaylistForCard).toHaveBeenNthCalledWith(
      2,
      THUMBNAIL_ROOT,
      'npub1example',
      'videos/Donkey',
      { cacheScope: 'root' },
    );
  });

  it('still probes a historical thumbnail root when the current card info only has an alias thumbnail url', async () => {
    const THUMBNAIL_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, () => 0x66) };
    getCachedPlaylistInfo.mockReturnValue(undefined);
    resolveReadableThumbnailRoot.mockResolvedValue(THUMBNAIL_ROOT);
    detectPlaylistForCard
      .mockResolvedValueOnce({
        videoCount: 0,
        rootCid: ROOT,
        duration: 44,
        title: 'Current root title',
        thumbnailUrl: '/htree/npub1example/videos%2FDonkey/thumbnail?v=deadbeef',
      })
      .mockResolvedValueOnce({
        videoCount: 0,
        rootCid: THUMBNAIL_ROOT,
        thumbnailUrl: '/htree/nhash1historic/thumbnail.jpg',
      });

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FDonkey',
      title: 'Donkey',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Donkey',
      rootCid: ROOT,
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      thumbnailUrl: '/htree/nhash1historic/thumbnail.jpg',
      duration: 44,
      title: 'Current root title',
    });
    expect(resolveReadableThumbnailRoot).toHaveBeenCalledTimes(1);
    expect(detectPlaylistForCard).toHaveBeenNthCalledWith(
      2,
      THUMBNAIL_ROOT,
      'npub1example',
      'videos/Donkey',
      { cacheScope: 'root' },
    );
  });

  it('replaces a stale exact thumbnail url when a historical thumbnail root is healthier', async () => {
    const THUMBNAIL_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, () => 0x67) };
    getCachedPlaylistInfo.mockReturnValue(undefined);
    resolveReadableThumbnailRoot.mockResolvedValue(THUMBNAIL_ROOT);
    detectPlaylistForCard
      .mockResolvedValueOnce({
        videoCount: 0,
        rootCid: ROOT,
        duration: 44,
        title: 'Current root title',
        thumbnailUrl: '/htree/nhash1stale/thumbnail.jpg',
      })
      .mockResolvedValueOnce({
        videoCount: 0,
        rootCid: THUMBNAIL_ROOT,
        thumbnailUrl: '/htree/nhash1historic/thumbnail.jpg',
      });

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FMine%20Bombers',
      title: 'Mine Bombers',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Mine Bombers',
      rootCid: ROOT,
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      thumbnailUrl: '/htree/nhash1historic/thumbnail.jpg',
      duration: 44,
      title: 'Current root title',
    });
    expect(detectPlaylistForCard).toHaveBeenNthCalledWith(1, ROOT, 'npub1example', 'videos/Mine Bombers');
    expect(detectPlaylistForCard).toHaveBeenNthCalledWith(
      2,
      THUMBNAIL_ROOT,
      'npub1example',
      'videos/Mine Bombers',
      { cacheScope: 'root' },
    );
  });

  it('falls back to the author tree event when resolver misses for a social feed video', async () => {
    getCachedPlaylistInfo.mockReturnValue(undefined);
    resolverResolve.mockResolvedValue(null);
    npubToPubkey.mockReturnValue('f'.repeat(64));
    ndkFetchEvent.mockResolvedValue({
      tags: [
        ['d', 'videos/Donkey Kong Country Soundtrack Full OST'],
        ['hash', '11'.repeat(32)],
      ],
    });
    detectPlaylistForCard.mockResolvedValue({
      videoCount: 0,
      thumbnailUrl: '/htree/nhash1social/thumbnail.jpg',
      duration: 88,
      title: 'Donkey',
    });

    const { getFeedVideoResolvedMedia } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FDonkey%20Kong%20Country%20Soundtrack%20Full%20OST',
      title: 'Donkey',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Donkey Kong Country Soundtrack Full OST',
    };

    await expect(getFeedVideoResolvedMedia(video)).resolves.toEqual({
      rootCid: { hash: Uint8Array.from({ length: 32 }, () => 0x11) },
      thumbnailUrl: '/htree/nhash1social/thumbnail.jpg',
      duration: 88,
      title: 'Donkey',
    });
    expect(ndkFetchEvent).toHaveBeenCalledWith({
      kinds: [30078],
      authors: ['f'.repeat(64)],
      '#d': ['videos/Donkey Kong Country Soundtrack Full OST'],
    }, { closeOnEose: true });
  });

  it('reapplies resolved feed media after later raw feed flushes', async () => {
    getCachedPlaylistInfo.mockReturnValue(undefined);
    detectPlaylistForCard.mockResolvedValue({
      videoCount: 0,
      thumbnailUrl: '/htree/nhash1persist/thumbnail.jpg',
      duration: 201,
      title: 'Persisted title',
    });

    const { feedStore, setFeedVideos } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FPersisted',
      title: 'Persisted',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Persisted',
      rootCid: ROOT,
    };

    let currentVideos: FeedVideo[] = [];
    const unsubscribe = feedStore.subscribe((value) => {
      currentVideos = value;
    });

    setFeedVideos([video]);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(currentVideos[0]).toMatchObject({
      title: 'Persisted title',
      duration: 201,
      thumbnailUrl: '/htree/nhash1persist/thumbnail.jpg',
    });

    setFeedVideos([video]);
    await Promise.resolve();

    expect(currentVideos[0]).toMatchObject({
      title: 'Persisted title',
      duration: 201,
      thumbnailUrl: '/htree/nhash1persist/thumbnail.jpg',
    });

    unsubscribe();
  });

  it('re-resolves feed items even when raw event metadata already has a thumbnail and duration', async () => {
    const BETTER_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, () => 0x22) };
    getCachedPlaylistInfo.mockReturnValue(undefined);
    detectPlaylistForCard.mockResolvedValue({
      videoCount: 0,
      rootCid: BETTER_ROOT,
      thumbnailUrl: '/htree/nhash1better/thumbnail.jpg',
      duration: 201,
      title: 'Readable title',
    });

    const { feedStore, setFeedVideos } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FReadable',
      title: 'Raw title',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Readable',
      rootCid: ROOT,
      thumbnailUrl: '/htree/nhash1raw/thumbnail.webp',
      duration: 33,
    };

    let currentVideos: FeedVideo[] = [];
    const unsubscribe = feedStore.subscribe((value) => {
      currentVideos = value;
    });

    setFeedVideos([video]);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(detectPlaylistForCard).toHaveBeenCalledWith(ROOT, 'npub1example', 'videos/Readable');
    expect(currentVideos[0]).toMatchObject({
      title: 'Readable title',
      duration: 201,
      thumbnailUrl: '/htree/nhash1better/thumbnail.jpg',
      rootCid: BETTER_ROOT,
    });

    unsubscribe();
  });

  it('retries feed media resolution when a tree root arrives after the initial miss', async () => {
    vi.useFakeTimers();
    getCachedPlaylistInfo.mockReturnValue(undefined);
    getLocalRootCache.mockReturnValue(undefined);
    resolverResolve.mockResolvedValue(null);
    detectPlaylistForCard.mockResolvedValue({
      videoCount: 0,
      thumbnailUrl: '/htree/nhash1late/thumbnail.jpg',
      duration: 93,
    });

    const { feedStore, setFeedVideos } = await import('../src/stores/feedStore');
    const video: FeedVideo = {
      href: '#/npub1example/videos%2FLate',
      title: 'Late',
      ownerPubkey: 'pubkey',
      ownerNpub: 'npub1example',
      treeName: 'videos/Late',
    };

    let currentVideos: FeedVideo[] = [];
    const unsubscribe = feedStore.subscribe((value) => {
      currentVideos = value;
    });

    setFeedVideos([video]);
    await flushAsyncUpdates();
    expect(detectPlaylistForCard).not.toHaveBeenCalled();

    getLocalRootCache.mockReturnValue(ROOT.hash);
    getLocalRootKey.mockReturnValue(undefined);
    for (const listener of cacheListeners) {
      listener('npub1example', 'videos/Late');
    }
    await flushAsyncUpdates();

    expect(detectPlaylistForCard).toHaveBeenCalledWith(ROOT, 'npub1example', 'videos/Late');
    expect(currentVideos[0]).toMatchObject({
      thumbnailUrl: '/htree/nhash1late/thumbnail.jpg',
      duration: 93,
    });

    unsubscribe();
  });
});
