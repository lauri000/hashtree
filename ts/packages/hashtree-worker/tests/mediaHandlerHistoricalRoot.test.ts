import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CID, HashTree } from '@hashtree/core';

const CURRENT_ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
const NPUB = 'npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk';
const TREE_NAME = 'videos/Mine Bombers in-game music';

const getCachedRoot = vi.fn();
const onCachedRootUpdate = vi.fn();
const subscribeToTreeRoots = vi.fn();
const resolveTreeRootNow = vi.fn();

const resolvePath = vi.fn();
const listDirectory = vi.fn();
const getBlob = vi.fn();
const readFile = vi.fn();
const readFileRange = vi.fn();

vi.mock('../src/iris/treeRootCache', () => ({
  getCachedRoot,
  onCachedRootUpdate,
}));

vi.mock('../src/iris/treeRootSubscription', () => ({
  subscribeToTreeRoots,
  resolveTreeRootNow,
}));

function makeTree(): HashTree {
  return {
    resolvePath,
    listDirectory,
    getBlob,
    readFile,
    readFileRange,
  } as unknown as HashTree;
}

describe('mediaHandler latest-only root resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    getCachedRoot.mockReset();
    onCachedRootUpdate.mockReset();
    subscribeToTreeRoots.mockReset();
    resolveTreeRootNow.mockReset();
    resolvePath.mockReset();
    listDirectory.mockReset();
    getBlob.mockReset();
    readFile.mockReset();
    readFileRange.mockReset();
    onCachedRootUpdate.mockReturnValue(() => {});
    getCachedRoot.mockResolvedValue(CURRENT_ROOT);
    resolveTreeRootNow.mockResolvedValue(CURRENT_ROOT);
  });

  it('does not fall back to a historical root when the latest mutable root cannot resolve a thumbnail alias', async () => {
    listDirectory.mockResolvedValue([{ name: 'video.mp4', cid: CURRENT_ROOT, size: 123 }]);

    const { __test__, initMediaHandler } = await import('../src/iris/mediaHandler');
    initMediaHandler(makeTree());

    await expect(
      __test__.resolveMutableTreeEntry(NPUB, TREE_NAME, 'thumbnail', {
        allowSingleSegmentRootFallback: false,
      }),
    ).resolves.toBeNull();
  });
});
