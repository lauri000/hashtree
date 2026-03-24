import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nhashEncode, type CID } from '@hashtree/core';

const listDirectory = vi.fn();
const readFile = vi.fn();

vi.mock('../src/store', () => ({
  getTree: () => ({
    listDirectory,
    readFile,
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

describe('detectPlaylistForCard thumbnail urls', () => {
  beforeEach(() => {
    vi.resetModules();
    listDirectory.mockReset();
    readFile.mockReset();
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

    await expect(detectPlaylistForCard(ROOT, 'npub1example', 'videos/Retry')).resolves.toBeNull();
    await expect(detectPlaylistForCard(ROOT, 'npub1example', 'videos/Retry')).resolves.toMatchObject({
      videoCount: 1,
      thumbnailUrl: `/htree/${nhashEncode(THUMB_A)}/thumbnail.webp?htree_c=test-media-client`,
    });
  });
});
