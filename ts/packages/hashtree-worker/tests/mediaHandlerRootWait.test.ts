import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CID } from '@hashtree/core';

const getCachedRoot = vi.fn();
const onCachedRootUpdate = vi.fn();
const subscribeToTreeRoots = vi.fn();
const resolveTreeRootNow = vi.fn();
const getHistoricalTreeRoots = vi.fn();

vi.mock('../src/iris/treeRootCache', () => ({
  getCachedRoot,
  onCachedRootUpdate,
}));

vi.mock('../src/iris/treeRootSubscription', () => ({
  subscribeToTreeRoots,
  resolveTreeRootNow,
  getHistoricalTreeRoots,
}));

const ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
const NPUB = 'npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk';
const TREE_NAME = 'videos/Test';

describe('mediaHandler root waiting', () => {
  beforeEach(() => {
    vi.resetModules();
    getCachedRoot.mockReset();
    onCachedRootUpdate.mockReset();
    subscribeToTreeRoots.mockReset();
    resolveTreeRootNow.mockReset();
    getHistoricalTreeRoots.mockReset();
    getHistoricalTreeRoots.mockResolvedValue([]);
  });

  it('actively resolves a missing cached root instead of only waiting for subscription updates', async () => {
    let notifyUpdate: ((npub: string, treeName: string, cid: CID | null) => void) | null = null;
    let releaseResolve: ((cid: CID | null) => void) | null = null;

    getCachedRoot.mockResolvedValue(null);
    onCachedRootUpdate.mockImplementation((listener: typeof notifyUpdate) => {
      notifyUpdate = listener;
      return () => {
        if (notifyUpdate === listener) {
          notifyUpdate = null;
        }
      };
    });
    resolveTreeRootNow.mockImplementation(() => new Promise((resolve) => {
      releaseResolve = resolve;
    }));

    const { __test__ } = await import('../src/iris/mediaHandler');
    const pending = __test__.waitForCachedRoot(NPUB, TREE_NAME);

    await Promise.resolve();

    expect(subscribeToTreeRoots).toHaveBeenCalled();
    expect(resolveTreeRootNow).toHaveBeenCalledWith(NPUB, TREE_NAME, 15000);

    releaseResolve?.(ROOT);

    await expect(pending).resolves.toEqual(ROOT);
    expect(notifyUpdate).toBeNull();
  });

  it('still accepts a later cache update when active root resolution misses', async () => {
    let notifyUpdate: ((npub: string, treeName: string, cid: CID | null) => void) | null = null;

    getCachedRoot.mockResolvedValue(null);
    onCachedRootUpdate.mockImplementation((listener: typeof notifyUpdate) => {
      notifyUpdate = listener;
      return () => {
        if (notifyUpdate === listener) {
          notifyUpdate = null;
        }
      };
    });
    resolveTreeRootNow.mockResolvedValue(null);

    const { __test__ } = await import('../src/iris/mediaHandler');
    const pending = __test__.waitForCachedRoot(NPUB, TREE_NAME);

    await Promise.resolve();
    notifyUpdate?.(NPUB, TREE_NAME, ROOT);

    await expect(pending).resolves.toEqual(ROOT);
    expect(resolveTreeRootNow).toHaveBeenCalledWith(NPUB, TREE_NAME, 15000);
  });
});
