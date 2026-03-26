import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex, type CID } from '@hashtree/core';

const listDirectory = vi.fn();
const resolvePath = vi.fn();
const readFileRange = vi.fn();
const readFile = vi.fn();
const ndkFetchEvents = vi.fn();
const npubToPubkey = vi.fn();
const querySync = vi.fn();
const poolClose = vi.fn();
const poolDestroy = vi.fn();

vi.mock('../src/store', () => ({
  getTree: () => ({
    listDirectory,
    resolvePath,
    readFileRange,
    readFile,
  }),
}));

vi.mock('../src/nostr', () => ({
  ndk: {
    fetchEvents: ndkFetchEvents,
  },
  npubToPubkey,
}));

vi.mock('nostr-tools', () => ({
  SimplePool: class {
    querySync = querySync;
    close = poolClose;
    destroy = poolDestroy;
  },
}));

const ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i) };
const ROOT_B: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 10) };
const ROOT_C: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 20) };
const FALLBACK: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 50) };
const VIDEO_DIR: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 100) };
const THUMB_MISSING: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 150) };
const THUMB_OK: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 180) };

function sameHash(cid: CID, other: CID): boolean {
  return toHex(cid.hash) === toHex(other.hash);
}

describe('resolveReadableVideoRoot', () => {
  beforeEach(() => {
    vi.resetModules();
    listDirectory.mockReset();
    resolvePath.mockReset();
    readFileRange.mockReset();
    readFile.mockReset();
    ndkFetchEvents.mockReset();
    npubToPubkey.mockReset();
    querySync.mockReset();
    poolClose.mockReset();
    poolDestroy.mockReset();
    npubToPubkey.mockReturnValue('f'.repeat(64));
    querySync.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the current root when it is readable', async () => {
    listDirectory.mockResolvedValue([{ name: 'video.mp4' }]);

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(ROOT);
    expect(ndkFetchEvents).not.toHaveBeenCalled();
  });

  it('checks fetchability before keeping a foreground single-file root', async () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
      });
    vi.stubGlobal('fetch', fetchMock);
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) return [{ name: 'video.mp4' }];
      if (sameHash(cid, FALLBACK)) return [{ name: 'thumbnail.jpg' }, { name: 'video.mp4' }];
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
      priority: 'foreground',
    })).resolves.toEqual(FALLBACK);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tries history fallback when the current root readability check times out', async () => {
    vi.useFakeTimers();
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) {
        return await new Promise(() => {});
      }
      if (sameHash(cid, FALLBACK)) {
        return [{ name: 'thumbnail.jpg' }, { name: 'video.mp4' }];
      }
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    const resultPromise = resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    });

    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(8000);

    await expect(resultPromise).resolves.toEqual(FALLBACK);
    expect(ndkFetchEvents).toHaveBeenCalledTimes(1);
  });

  it('returns the current root when readability checks time out and no fallback is available', async () => {
    vi.useFakeTimers();
    listDirectory.mockImplementation(() => new Promise(() => {}));
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    const resultPromise = resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    });

    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(resultPromise).resolves.toEqual(ROOT);
    expect(ndkFetchEvents).toHaveBeenCalledTimes(1);
  });

  it('falls back to the most recent readable prior root', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) return [];
      if (sameHash(cid, FALLBACK)) return [{ name: 'thumbnail.jpg' }, { name: 'video.mp4' }];
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(FALLBACK);
  });

  it('prefers a historical video root over a newer audio-only root', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) return [{ name: 'video.flac' }];
      if (sameHash(cid, FALLBACK)) return [{ name: 'thumbnail.jpg' }, { name: 'video.mp4' }];
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(FALLBACK);
  });

  it('prefers a historical mp4 root over a newer lower-priority video container', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) return [{ name: 'video.mkv' }];
      if (sameHash(cid, FALLBACK)) return [{ name: 'thumbnail.jpg' }, { name: 'video.mp4' }];
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(FALLBACK);
  });

  it('prefers a historical single-file mp4 root over a newer multi-format root with the same best filename', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) {
        return [
          { name: 'video.mp4' },
          { name: 'video.mkv' },
          { name: 'video.flac' },
        ];
      }
      if (sameHash(cid, FALLBACK)) return [{ name: 'thumbnail.jpg' }, { name: 'video.mp4' }];
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(FALLBACK);
  });

  it('can recover a historical readable root when no current root is available', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, FALLBACK)) return [{ name: 'thumbnail.jpg' }, { name: 'video.mp4' }];
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableVideoRoot({
      rootCid: null,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(FALLBACK);
  });

  it('falls back to the most recent readable prior root with thumbnail evidence when the current root is thumbnail-less', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) return [{ name: 'video.mp4' }];
      if (sameHash(cid, FALLBACK)) return [{ name: 'video.mp4' }, { name: 'thumbnail.jpg' }];
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableThumbnailRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableThumbnailRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(FALLBACK);
  });

  it('falls back when the current root advertises a thumbnail file whose blob is unreadable', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) {
        return [
          { name: 'video.mp4' },
          { name: 'thumbnail.jpeg', cid: THUMB_MISSING },
        ];
      }
      if (sameHash(cid, FALLBACK)) {
        return [
          { name: 'video.mp4' },
          { name: 'thumbnail.jpg', cid: THUMB_OK },
        ];
      }
      return [];
    });
    readFileRange.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, THUMB_OK)) {
        return new Uint8Array([0xff, 0xd8, 0xff]);
      }
      if (sameHash(cid, THUMB_MISSING)) {
        return null;
      }
      return null;
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableThumbnailRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableThumbnailRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(FALLBACK);
  });

  it('waits for a slower raw relay history response when ndk history is empty and the raw response contains a thumbnail-rich prior root', async () => {
    vi.useFakeTimers();
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) return [{ name: 'video.mp4' }];
      if (sameHash(cid, FALLBACK)) return [{ name: 'video.mp4' }, { name: 'thumbnail.jpg' }];
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set());
    querySync.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => {
        resolve([
          {
            created_at: 20,
            tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
          },
          {
            created_at: 10,
            tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
          },
        ]);
      }, 3600);
    }));

    const { resolveReadableThumbnailRoot } = await import('../src/lib/readableVideoRoot');
    const resultPromise = resolveReadableThumbnailRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    });

    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(3600);

    await expect(resultPromise).resolves.toEqual(FALLBACK);
    expect(querySync).toHaveBeenCalledTimes(1);
  });

  it('still allows raw relay history queries in native mode when ndk history misses', async () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'htree:',
        hostname: 'npub1example',
        search: '',
      },
      __HTREE_SERVER_URL__: 'http://127.0.0.1:21417',
    });
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) return [{ name: 'video.mp4' }];
      if (sameHash(cid, FALLBACK)) return [{ name: 'video.mp4' }, { name: 'thumbnail.jpg' }];
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
    ]));
    querySync.mockResolvedValue([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]);

    const { resolveReadableThumbnailRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableThumbnailRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(FALLBACK);
    expect(querySync).toHaveBeenCalledTimes(1);
  });

  it('starts raw relay history lookup immediately when ndk history hangs', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) return [{ name: 'video.mp4' }];
      if (sameHash(cid, FALLBACK)) return [{ name: 'video.mp4' }, { name: 'thumbnail.jpg' }];
      return [];
    });
    ndkFetchEvents.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Set()), 20);
    }));
    querySync.mockResolvedValue([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]);

    const { resolveReadableThumbnailRoot } = await import('../src/lib/readableVideoRoot');
    const resultPromise = resolveReadableThumbnailRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(querySync).toHaveBeenCalledTimes(1);

    await expect(resultPromise).resolves.toEqual(FALLBACK);
  });

  it('treats direct-root playable blobs as readable without falling back to history', async () => {
    listDirectory.mockResolvedValue([]);
    readFileRange.mockResolvedValue(new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d,
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Mine Bombers',
    })).resolves.toEqual(ROOT);
    expect(ndkFetchEvents).not.toHaveBeenCalled();
  });

  it('treats metadata-only roots as unreadable and falls back to a playable prior root', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) return [{ name: 'thumbnail.jpg' }, { name: 'metadata.json' }];
      if (sameHash(cid, FALLBACK)) return [{ name: 'thumbnail.jpg' }, { name: 'video.mp4' }];
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(FALLBACK);
  });

  it('checks playlist child readability when videoId is provided', async () => {
    resolvePath.mockImplementation(async (cid: CID, path: string) => {
      if (path !== 'clip_1') return null;
      if (sameHash(cid, ROOT)) return null;
      if (sameHash(cid, FALLBACK)) return { cid: VIDEO_DIR };
      return null;
    });
    listDirectory.mockImplementation(async (cid: CID) => {
      if (cid === VIDEO_DIR) return [{ name: 'video.mp4' }];
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');
    await expect(resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
      videoId: 'clip_1',
    })).resolves.toEqual(FALLBACK);
  });

  it('caches no-fallback results briefly to avoid repeated history probes for the same root', async () => {
    listDirectory.mockResolvedValue([]);
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Test'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
    ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');

    await expect(resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(ROOT);

    await expect(resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Test',
    })).resolves.toEqual(ROOT);

    expect(ndkFetchEvents).toHaveBeenCalledTimes(1);
  });

  it('prioritizes foreground root fallback ahead of queued background probes', async () => {
    let releaseBackgroundOne: ((value: Set<never>) => void) | null = null;
    let releaseBackgroundTwo: ((value: Set<never>) => void) | null = null;
    let releaseBackgroundThree: ((value: Set<never>) => void) | null = null;
    let releaseBackgroundFour: ((value: Set<never>) => void) | null = null;

    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, FALLBACK)) return [{ name: 'video.mp4' }];
      return [];
    });
    ndkFetchEvents
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseBackgroundOne = resolve as (value: Set<never>) => void;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseBackgroundTwo = resolve as (value: Set<never>) => void;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseBackgroundThree = resolve as (value: Set<never>) => void;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseBackgroundFour = resolve as (value: Set<never>) => void;
      }))
      .mockResolvedValueOnce(new Set([
        {
          created_at: 30,
          tags: [['d', 'videos/Foreground'], ['hash', Buffer.from(ROOT_C.hash).toString('hex')]],
        },
        {
          created_at: 20,
          tags: [['d', 'videos/Foreground'], ['hash', Buffer.from(FALLBACK.hash).toString('hex')]],
        },
      ]));

    const { resolveReadableVideoRoot } = await import('../src/lib/readableVideoRoot');

    const backgroundOne = resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Background One',
      priority: 'background',
    });
    const backgroundTwo = resolveReadableVideoRoot({
      rootCid: ROOT_B,
      npub: 'npub1example',
      treeName: 'videos/Background Two',
      priority: 'background',
    });
    const backgroundThree = resolveReadableVideoRoot({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Background Three',
      priority: 'background',
    });
    const backgroundFour = resolveReadableVideoRoot({
      rootCid: ROOT_B,
      npub: 'npub1example',
      treeName: 'videos/Background Four',
      priority: 'background',
    });

    await Promise.resolve();
    await Promise.resolve();

    await expect(resolveReadableVideoRoot({
      rootCid: ROOT_C,
      npub: 'npub1example',
      treeName: 'videos/Foreground',
      priority: 'foreground',
    })).resolves.toEqual(FALLBACK);

    releaseBackgroundOne?.(new Set());
    releaseBackgroundTwo?.(new Set());
    releaseBackgroundThree?.(new Set());
    releaseBackgroundFour?.(new Set());

    await expect(backgroundOne).resolves.toEqual(ROOT);
    await expect(backgroundTwo).resolves.toEqual(ROOT_B);
    await expect(backgroundThree).resolves.toEqual(ROOT);
    await expect(backgroundFour).resolves.toEqual(ROOT_B);
  });
});
