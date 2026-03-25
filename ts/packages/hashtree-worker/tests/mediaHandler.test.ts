import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CID, HashTree } from '@hashtree/core';
import { __test__, initMediaHandler } from '../src/iris/mediaHandler';

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
    resolvePath.mockResolvedValue(null);
    listDirectory.mockResolvedValue([{ name: 'thumbnail.jpg', cid: ROOT_THUMB, size: 123 }]);

    await expect(
      __test__.resolveCidWithinRoot(ROOT, 'thumbnail', { allowSingleSegmentRootFallback: true })
    ).resolves.toBe(ROOT_THUMB);
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it('resolves nested thumbnail aliases before looking up the file cid', async () => {
    resolvePath.mockResolvedValue(null);
    listDirectory.mockImplementation(async (cid: CID) => {
      if (cid === ROOT) {
        return [{ name: 'video_123', cid: CHILD_DIR, size: 0 }];
      }
      if (cid === CHILD_DIR) {
        return [{ name: 'thumbnail.jpg', cid: CHILD_THUMB, size: 1 }];
      }
      return [];
    });

    await expect(
      __test__.resolveCidWithinRoot(ROOT, 'video_123/thumbnail', { allowSingleSegmentRootFallback: true })
    ).resolves.toBe(CHILD_THUMB);
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it('resolves nested direct file paths from cached directory listings instead of tree.resolvePath', async () => {
    resolvePath.mockResolvedValue(null);
    listDirectory.mockImplementation(async (cid: CID) => {
      if (cid === ROOT) {
        return [{ name: 'video_123', cid: CHILD_DIR, size: 0 }];
      }
      if (cid === CHILD_DIR) {
        return [{ name: 'thumbnail.jpg', cid: CHILD_THUMB, size: 321 }];
      }
      return [];
    });

    await expect(
      __test__.resolveCidWithinRoot(ROOT, 'video_123/thumbnail.jpg', { allowSingleSegmentRootFallback: false })
    ).resolves.toBe(CHILD_THUMB);
    expect(resolvePath).not.toHaveBeenCalled();
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

  it('coalesces concurrent immutable thumbnail lookups for the same root path', async () => {
    let releaseList: ((entries: Array<{ name: string; cid: CID; size: number }>) => void) | null = null;
    listDirectory.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseList = resolve;
        })
    );

    const first = __test__.resolveCidWithinRoot(ROOT, 'thumbnail', {
      allowSingleSegmentRootFallback: true,
    });
    const second = __test__.resolveCidWithinRoot(ROOT, 'thumbnail', {
      allowSingleSegmentRootFallback: true,
    });

    await Promise.resolve();

    expect(listDirectory).toHaveBeenCalledTimes(1);

    releaseList?.([{ name: 'thumbnail.jpg', cid: ROOT_THUMB, size: 123 }]);

    await expect(first).resolves.toBe(ROOT_THUMB);
    await expect(second).resolves.toBe(ROOT_THUMB);
  });

  it('clears immutable lookup caches when initialized with a new tree', async () => {
    listDirectory.mockResolvedValue([{ name: 'thumbnail.jpg', cid: ROOT_THUMB, size: 1 }]);

    await expect(
      __test__.resolveCidWithinRoot(ROOT, 'thumbnail', { allowSingleSegmentRootFallback: true })
    ).resolves.toBe(ROOT_THUMB);
    expect(listDirectory).toHaveBeenCalledTimes(1);

    const nextListDirectory = vi.fn().mockResolvedValue([
      { name: 'thumbnail.jpg', cid: CHILD_THUMB, size: 2 },
    ]);
    initMediaHandler({
      resolvePath: vi.fn(),
      listDirectory: nextListDirectory,
    } as unknown as HashTree);

    await expect(
      __test__.resolveCidWithinRoot(ROOT, 'thumbnail', { allowSingleSegmentRootFallback: true })
    ).resolves.toBe(CHILD_THUMB);
    expect(nextListDirectory).toHaveBeenCalledTimes(1);
  });
});
