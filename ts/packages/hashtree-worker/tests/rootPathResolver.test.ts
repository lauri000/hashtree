import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CID } from '@hashtree/core';
import { DEFAULT_ROOT_PATH_RESOLVE_TIMEOUT_MS, parseRootPath, resolveRootPath } from '../src/iris/rootPathResolver';

const { resolveTreeRootNow } = vi.hoisted(() => ({
  resolveTreeRootNow: vi.fn(),
}));

vi.mock('../src/iris/treeRootSubscription', () => ({
  resolveTreeRootNow,
}));

const ROOT: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
const CHILD: CID = { hash: Uint8Array.from({ length: 32 }, (_, i) => i + 33) };
const NPUB = 'npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk';

describe('rootPathResolver', () => {
  beforeEach(() => {
    vi.resetModules();
    resolveTreeRootNow.mockReset();
  });

  it('actively resolves a missing root instead of returning null immediately', async () => {
    resolveTreeRootNow
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ROOT);
    const resolvePath = vi.fn().mockResolvedValue({ cid: CHILD });

    await expect(resolveRootPath({ resolvePath }, NPUB, 'videos/Mine Bombers in-game music'))
      .resolves.toEqual(CHILD);

    expect(resolveTreeRootNow).toHaveBeenNthCalledWith(1, NPUB, 'videos/Mine Bombers in-game music', DEFAULT_ROOT_PATH_RESOLVE_TIMEOUT_MS);
    expect(resolveTreeRootNow).toHaveBeenCalledWith(NPUB, 'videos', DEFAULT_ROOT_PATH_RESOLVE_TIMEOUT_MS);
    expect(resolvePath).toHaveBeenCalledWith(ROOT, ['Mine Bombers in-game music']);
  });

  it('returns the exact tree root when the full path is itself the tree name', async () => {
    const resolvePath = vi.fn();
    resolveTreeRootNow.mockResolvedValue(ROOT);

    await expect(resolveRootPath({ resolvePath }, NPUB, 'videos/Mine Bombers in-game music')).resolves.toEqual(ROOT);

    expect(resolvePath).not.toHaveBeenCalled();
  });

  it('keeps public as the default tree name when no path is provided', async () => {
    resolveTreeRootNow.mockResolvedValue(null);

    await expect(resolveRootPath({ resolvePath: vi.fn() }, NPUB)).resolves.toBeNull();

    expect(resolveTreeRootNow).toHaveBeenCalledWith(NPUB, 'public', DEFAULT_ROOT_PATH_RESOLVE_TIMEOUT_MS);
  });

  it('parses root paths into tree and subpath segments', () => {
    expect(parseRootPath('videos/Music/video_123')).toEqual({
      treeName: 'videos',
      subPath: ['Music', 'video_123'],
    });
    expect(parseRootPath()).toEqual({
      treeName: 'public',
      subPath: [],
    });
  });

  it('resolves nested paths relative to the fetched root', async () => {
    resolveTreeRootNow
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ROOT);
    const resolvePath = vi.fn().mockResolvedValue({ cid: CHILD });

    await expect(resolveRootPath({ resolvePath }, NPUB, 'repo/src/index.ts')).resolves.toEqual(CHILD);

    expect(resolvePath).toHaveBeenCalledWith(ROOT, ['src', 'index.ts']);
  });
});
