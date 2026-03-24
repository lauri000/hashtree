import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nhashEncode, type CID } from '@hashtree/core';

const listDirectory = vi.fn();

vi.mock('../src/store', () => ({
  getTree: () => ({
    listDirectory,
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
});
