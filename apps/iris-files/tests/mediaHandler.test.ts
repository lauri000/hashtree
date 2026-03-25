import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CID, HashTree } from '@hashtree/core';
import { __test__, initMediaHandler } from '../src/worker/mediaHandler';

const ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i), key: undefined };
const CHILD_DIR: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 1), key: undefined };
const ROOT_THUMB: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 2), key: undefined };
const CHILD_THUMB: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 3), key: undefined };

const resolvePath = vi.fn();
const listDirectory = vi.fn();

function makeTree(): HashTree {
  return {
    resolvePath,
    listDirectory,
  } as unknown as HashTree;
}

describe('mediaHandler thumbnail aliases', () => {
  beforeEach(() => {
    resolvePath.mockReset();
    listDirectory.mockReset();
    initMediaHandler(makeTree());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves a root thumbnail alias for immutable nhash requests', async () => {
    resolvePath.mockImplementation(async (cid: CID, path: string) => {
      if (cid === ROOT && path === 'thumbnail.jpg') {
        return { cid: ROOT_THUMB };
      }
      return null;
    });
    listDirectory.mockResolvedValue([{ name: 'thumbnail.jpg' }]);

    await expect(
      __test__.resolveCidWithinRoot(ROOT, 'thumbnail', { allowSingleSegmentRootFallback: true })
    ).resolves.toBe(ROOT_THUMB);
  });

  it('resolves nested thumbnail aliases before looking up the file cid', async () => {
    resolvePath.mockImplementation(async (cid: CID, path: string) => {
      if (cid === ROOT && path === 'video_123') {
        return { cid: CHILD_DIR };
      }
      if (cid === ROOT && path === 'video_123/thumbnail.jpg') {
        return { cid: CHILD_THUMB };
      }
      return null;
    });
    listDirectory.mockImplementation(async (cid: CID) => {
      if (cid === CHILD_DIR) {
        return [{ name: 'thumbnail.jpg' }];
      }
      return [];
    });

    await expect(
      __test__.resolveCidWithinRoot(ROOT, 'video_123/thumbnail', { allowSingleSegmentRootFallback: true })
    ).resolves.toBe(CHILD_THUMB);
  });

  it('treats immutable single-segment paths as direct file cids when the root is not a directory', async () => {
    vi.useFakeTimers();
    listDirectory.mockImplementation(() => new Promise(() => {}));

    const result = __test__.resolveCidWithinRoot(ROOT, 'video.mp4', {
      allowSingleSegmentRootFallback: true,
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toBe(ROOT);
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it('does not treat a thumbnail alias as a direct file cid when the root is not a directory', async () => {
    vi.useFakeTimers();
    listDirectory.mockImplementation(() => new Promise(() => {}));

    const result = __test__.resolveCidWithinRoot(ROOT, 'thumbnail', {
      allowSingleSegmentRootFallback: true,
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toBeNull();
    expect(resolvePath).not.toHaveBeenCalled();
  });
});
