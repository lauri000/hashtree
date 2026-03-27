import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nhashEncode, toHex, type CID } from '@hashtree/core';

const listDirectory = vi.fn();
const readFile = vi.fn();
const readFileRange = vi.fn();
const resolvePath = vi.fn();
const ndkFetchEvents = vi.fn();
const npubToPubkey = vi.fn();
const resolveReadableVideoRoot = vi.fn();
const querySync = vi.fn();
const closePool = vi.fn();
const destroyPool = vi.fn();

vi.mock('../src/store', () => ({
  getTree: () => ({
    listDirectory,
    readFile,
    readFileRange,
    resolvePath,
  }),
  localStore: {
    put: vi.fn(),
    get: vi.fn(),
    has: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
    totalBytes: vi.fn(),
  },
}));

vi.mock('../src/nostr', () => ({
  ndk: {
    fetchEvents: ndkFetchEvents,
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

vi.mock('../src/lib/readableVideoRoot', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/readableVideoRoot')>('../src/lib/readableVideoRoot');
  return {
    ...actual,
    resolveReadableVideoRoot,
  };
});

function installWindow(): void {
  vi.stubGlobal('window', {
    location: {
      protocol: 'https:',
      hostname: 'video.iris.to',
      search: '',
      hash: '#/',
    },
  });
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-media-client',
  });
}

const ROOT: CID = { hash: new Uint8Array(32) };
const VIDEO_DIR_A: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
const VIDEO_DIR_B: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 2) };
const THUMB_A: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 3) };
const THUMB_B: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 4) };

function sameHash(cid: CID, other: CID): boolean {
  return toHex(cid.hash) === toHex(other.hash);
}

describe('detectPlaylistForCard thumbnail urls', () => {
  beforeEach(async () => {
    vi.resetModules();
    listDirectory.mockReset();
    readFile.mockReset();
    readFileRange.mockReset();
    resolvePath.mockReset();
    ndkFetchEvents.mockReset();
    npubToPubkey.mockReset();
    resolveReadableVideoRoot.mockReset();
    querySync.mockReset();
    closePool.mockReset();
    destroyPool.mockReset();
    const actual = await vi.importActual<typeof import('../src/lib/readableVideoRoot')>('../src/lib/readableVideoRoot');
    resolveReadableVideoRoot.mockImplementation(actual.resolveReadableVideoRoot);
    npubToPubkey.mockReturnValue('f'.repeat(64));
    querySync.mockResolvedValue([]);
    installWindow();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the exact thumbnail file cid for single videos', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (cid === ROOT) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_A },
          { name: 'thumbnail.jpg', cid: THUMB_A },
        ];
      }
      return [];
    });

    const { detectPlaylistForCard } = await import('../src/stores/playlist');
    const info = await detectPlaylistForCard(ROOT, 'npub1example', 'videos/Test Clip');

    expect(info?.videoCount).toBe(0);
    expect(info?.thumbnailUrl).toBe(
      `/htree/${nhashEncode(THUMB_A)}/thumbnail.jpg?htree_c=test-media-client`,
    );
  });

  it('accepts generic jpeg artwork files for single-video thumbnails', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (cid === ROOT) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_A },
          { name: 'cover.jpeg', cid: THUMB_A },
        ];
      }
      return [];
    });

    const { detectPlaylistForCard } = await import('../src/stores/playlist');
    const info = await detectPlaylistForCard(ROOT, 'npub1example', 'videos/Mine Bombers in-game music');

    expect(info?.videoCount).toBe(0);
    expect(info?.thumbnailUrl).toBe(
      `/htree/${nhashEncode(THUMB_A)}/cover.jpeg?htree_c=test-media-client`,
    );
  });

  it('detects legacy audio uploads as single media items', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (cid === ROOT) {
        return [
          { name: 'video.mp3', cid: VIDEO_DIR_A },
          { name: 'thumbnail.jpg', cid: THUMB_A },
        ];
      }
      return [];
    });

    const { detectPlaylistForCard } = await import('../src/stores/playlist');
    const info = await detectPlaylistForCard(ROOT, 'npub1example', 'videos/B Sirius Baby');

    expect(info?.videoCount).toBe(0);
    expect(info?.videoPath).toBe('video.mp3');
    expect(info?.thumbnailUrl).toBe(
      `/htree/${nhashEncode(THUMB_A)}/thumbnail.jpg?htree_c=test-media-client`,
    );
  });

  it('uses thumbnail nhash stored in single-video link metadata', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (cid === ROOT) {
        return [
          {
            name: 'video.mp4',
            cid: VIDEO_DIR_A,
            meta: {
              duration: 123,
              thumbnail: nhashEncode(THUMB_A),
            },
          },
        ];
      }
      return [];
    });

    const { detectPlaylistForCard } = await import('../src/stores/playlist');
    const info = await detectPlaylistForCard(ROOT, 'npub1example', 'videos/Stored Meta Thumbnail');

    expect(info?.videoCount).toBe(0);
    expect(info?.duration).toBe(123);
    expect(info?.thumbnailUrl).toBe(
      `/htree/${nhashEncode(THUMB_A)}?htree_c=test-media-client`,
    );
  });

  it('uses thumbnail metadata stored in metadata.json for legacy single videos', async () => {
    const metadataCid: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 9) };
    listDirectory.mockImplementation(async (cid: CID) => {
      if (cid === ROOT) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_A },
          { name: 'thumbnail.jpg', cid: THUMB_A },
          { name: 'metadata.json', cid: metadataCid },
        ];
      }
      return [];
    });
    readFile.mockImplementation(async (cid: CID) => {
      if (cid === metadataCid) {
        return new TextEncoder().encode(JSON.stringify({
          thumbnail: 'thumbnail.jpg',
          duration: 321,
        }));
      }
      return null;
    });

    const { detectPlaylistForCard } = await import('../src/stores/playlist');
    const info = await detectPlaylistForCard(ROOT, 'npub1example', 'videos/Legacy Metadata Thumbnail');

    expect(info?.videoCount).toBe(0);
    expect(info?.duration).toBe(321);
    expect(info?.thumbnailUrl).toBe(
      `/htree/${nhashEncode(THUMB_A)}/thumbnail.jpg?htree_c=test-media-client`,
    );
  });

  it('uses the first playlist child thumbnail file cid instead of a root alias', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (cid === ROOT) {
        return [
          { name: 'video_b', cid: VIDEO_DIR_B },
          { name: 'video_a', cid: VIDEO_DIR_A },
        ];
      }
      if (cid === VIDEO_DIR_A) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_A },
          { name: 'thumbnail.webp', cid: THUMB_A },
        ];
      }
      if (cid === VIDEO_DIR_B) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_B },
          { name: 'thumbnail.jpg', cid: THUMB_B },
        ];
      }
      return [];
    });

    const { detectPlaylistForCard } = await import('../src/stores/playlist');
    const info = await detectPlaylistForCard(ROOT, 'npub1example', 'videos/Music');

    expect(info?.videoCount).toBe(2);
    expect(info?.thumbnailUrl).toBe(
      `/htree/${nhashEncode(THUMB_A)}/thumbnail.webp?htree_c=test-media-client`,
    );
  });

  it('retries playlist detection after a transient tree read failure', async () => {
    listDirectory
      .mockRejectedValueOnce(new Error('temporary miss'))
      .mockImplementation(async (cid: CID) => {
        if (cid === ROOT) {
          return [
            { name: 'video_a', cid: VIDEO_DIR_A },
          ];
        }
        if (cid === VIDEO_DIR_A) {
          return [
            { name: 'video.mp4', cid: VIDEO_DIR_A },
            { name: 'thumbnail.webp', cid: THUMB_A },
          ];
        }
        return [];
      });

    const { detectPlaylistForCard } = await import('../src/stores/playlist');

    await expect(detectPlaylistForCard(ROOT, 'npub1example', 'videos/Retry')).resolves.toMatchObject({
      videoCount: 1,
      thumbnailUrl: `/htree/${nhashEncode(THUMB_A)}/thumbnail.webp?htree_c=test-media-client`,
    });
  });

  it('falls back to a prior readable root when the latest root is empty', async () => {
    const FALLBACK_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 33) };
    resolveReadableVideoRoot.mockResolvedValue(FALLBACK_ROOT);
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) {
        return [];
      }
      if (sameHash(cid, FALLBACK_ROOT)) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_A },
          { name: 'thumbnail.jpg', cid: THUMB_A },
        ];
      }
      return [];
    });
    ndkFetchEvents.mockResolvedValue(new Set([
      {
        created_at: 20,
        tags: [['d', 'videos/Broken'], ['hash', Buffer.from(ROOT.hash).toString('hex')]],
      },
      {
        created_at: 10,
        tags: [['d', 'videos/Broken'], ['hash', Buffer.from(FALLBACK_ROOT.hash).toString('hex')]],
      },
    ]));

    const { detectPlaylistForCard } = await import('../src/stores/playlist');
    const info = await detectPlaylistForCard(ROOT, 'npub1example', 'videos/Broken');

    expect(resolveReadableVideoRoot).toHaveBeenCalledWith({
      rootCid: ROOT,
      npub: 'npub1example',
      treeName: 'videos/Broken',
      priority: 'background',
    });
    expect(info?.rootCid).toEqual(FALLBACK_ROOT);
    expect(info?.videoCount).toBe(0);
    expect(info?.thumbnailUrl).toBe(
      `/htree/${nhashEncode(THUMB_A)}/thumbnail.jpg?htree_c=test-media-client`,
    );
  });

  it('can inspect an alternate immutable root without reusing a stale tree-scoped cache entry', async () => {
    const THUMBNAIL_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 33) };
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_A },
        ];
      }
      if (sameHash(cid, THUMBNAIL_ROOT)) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_A },
          { name: 'thumbnail.jpg', cid: THUMB_B },
        ];
      }
      return [];
    });

    const { detectPlaylistForCard } = await import('../src/stores/playlist');

    const currentInfo = await detectPlaylistForCard(ROOT, 'npub1example', 'videos/Donkey');
    expect(currentInfo?.thumbnailUrl).toBeUndefined();

    const thumbnailInfo = await detectPlaylistForCard(THUMBNAIL_ROOT, 'npub1example', 'videos/Donkey', {
      cacheScope: 'root',
    });
    expect(thumbnailInfo?.rootCid).toEqual(THUMBNAIL_ROOT);
    expect(thumbnailInfo?.thumbnailUrl).toBe(
      `/htree/${nhashEncode(THUMB_B)}/thumbnail.jpg?htree_c=test-media-client`,
    );
  });

  it('keeps a caller-provided thumbnail root exact when cacheScope is root', async () => {
    const THUMBNAIL_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 41) };
    resolveReadableVideoRoot.mockImplementation(async ({ rootCid }: { rootCid: CID }) => {
      if (sameHash(rootCid, THUMBNAIL_ROOT)) {
        return ROOT;
      }
      return rootCid;
    });
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, ROOT)) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_A },
        ];
      }
      if (sameHash(cid, THUMBNAIL_ROOT)) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_A },
          { name: 'thumbnail.jpg', cid: THUMB_B },
        ];
      }
      return [];
    });

    const { detectPlaylistForCard } = await import('../src/stores/playlist');
    const info = await detectPlaylistForCard(THUMBNAIL_ROOT, 'npub1example', 'videos/Remember this', {
      cacheScope: 'root',
    });

    expect(info?.rootCid).toEqual(THUMBNAIL_ROOT);
    expect(info?.thumbnailUrl).toBe(
      `/htree/${nhashEncode(THUMB_B)}/thumbnail.jpg?htree_c=test-media-client`,
    );
  });

  it('keeps a caller-provided thumbnail root exact for direct video card lookups', async () => {
    const THUMBNAIL_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 51) };
    const THUMB_CHILD: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 61) };
    resolveReadableVideoRoot.mockImplementation(async ({ rootCid }: { rootCid: CID }) => {
      if (sameHash(rootCid, THUMBNAIL_ROOT)) {
        return ROOT;
      }
      return rootCid;
    });
    resolvePath.mockImplementation(async (cid: CID, path: string) => {
      if (sameHash(cid, THUMBNAIL_ROOT) && path === 'video_123') {
        return { cid: THUMB_CHILD };
      }
      if (sameHash(cid, ROOT) && path === 'video_123') {
        return { cid: VIDEO_DIR_A };
      }
      return null;
    });
    listDirectory.mockImplementation(async (cid: CID) => {
      if (sameHash(cid, THUMB_CHILD)) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_A },
          { name: 'thumbnail.webp', cid: THUMB_B },
        ];
      }
      if (sameHash(cid, VIDEO_DIR_A)) {
        return [
          { name: 'video.mp4', cid: VIDEO_DIR_A },
        ];
      }
      return [];
    });

    const { detectVideoCardInfo } = await import('../src/stores/playlist');
    const info = await detectVideoCardInfo(
      THUMBNAIL_ROOT,
      'npub1example',
      'videos/Music',
      'video_123',
      { exactRoot: true },
    );

    expect(info?.thumbnailUrl).toBe(
      `/htree/${nhashEncode(THUMB_B)}/thumbnail.webp?htree_c=test-media-client`,
    );
  });

  it('treats direct-root playable blobs as single videos even when the root is not listable', async () => {
    listDirectory.mockResolvedValue([]);
    readFileRange.mockResolvedValue(new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d,
    ]));

    const { detectPlaylistForCard } = await import('../src/stores/playlist');
    const info = await detectPlaylistForCard(ROOT, 'npub1example', 'videos/Mine Bombers in-game music');

    expect(info?.videoCount).toBe(0);
    expect(info?.videoPath).toBe('video.mp4');
    expect(info?.title).toBe('Mine Bombers in-game music');
    expect(info?.rootCid).toEqual(ROOT);
  });
});
