import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CID } from '@hashtree/core';

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

const ROOT: CID = { hash: new Uint8Array(32), key: undefined };
const CID_A: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i), key: undefined };
const CID_B: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 1), key: undefined };
const CID_C: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 2), key: undefined };

describe('findFirstVideoEntry', () => {
  beforeEach(() => {
    listDirectory.mockReset();
  });

  it('skips child directories that do not contain a video file', async () => {
    listDirectory.mockImplementation(async (cid: CID) => {
      if (cid === ROOT) {
        return [
          { name: 'aaa-meta', cid: CID_A },
          { name: 'video_b', cid: CID_B },
          { name: 'video_a', cid: CID_C },
        ];
      }
      if (cid === CID_A) {
        return [{ name: 'info.json' }];
      }
      if (cid === CID_B) {
        return [{ name: 'video.mp4' }];
      }
      if (cid === CID_C) {
        return [{ name: 'video.webm' }];
      }
      return [];
    });

    const { findFirstVideoEntry } = await import('../src/stores/playlist');
    await expect(findFirstVideoEntry(ROOT)).resolves.toBe('video_a');
  });

  it('returns null when the root already contains a video file', async () => {
    listDirectory.mockResolvedValue([{ name: 'video.mp4', cid: CID_A }]);

    const { findFirstVideoEntry } = await import('../src/stores/playlist');
    await expect(findFirstVideoEntry(ROOT)).resolves.toBeNull();
  });
});
