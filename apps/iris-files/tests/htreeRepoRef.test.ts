import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkType, type CID } from '@hashtree/core';

vi.mock('../src/lib/workerInit', () => ({
  getWorkerAdapter: vi.fn(),
}));

vi.mock('../src/stores/treeRoot', () => ({
  waitForTreeRoot: vi.fn(),
}));

vi.mock('../src/treeRootCache', () => ({
  getLocalRootCache: vi.fn(),
  getLocalRootKey: vi.fn(),
}));

vi.mock('../src/store', () => ({
  getTree: vi.fn(),
}));

import { resolveRepoRootCid } from '../src/utils/htreeRepoRef';
import { getWorkerAdapter } from '../src/lib/workerInit';
import { waitForTreeRoot } from '../src/stores/treeRoot';
import { getLocalRootCache, getLocalRootKey } from '../src/treeRootCache';
import { getTree } from '../src/store';

function makeCid(seed: number): CID {
  return { hash: new Uint8Array([seed]) };
}

describe('resolveRepoRootCid', () => {
  const getWorkerAdapterMock = vi.mocked(getWorkerAdapter);
  const waitForTreeRootMock = vi.mocked(waitForTreeRoot);
  const getLocalRootCacheMock = vi.mocked(getLocalRootCache);
  const getLocalRootKeyMock = vi.mocked(getLocalRootKey);
  const getTreeMock = vi.mocked(getTree);

  beforeEach(() => {
    vi.clearAllMocks();
    getWorkerAdapterMock.mockReturnValue(null as never);
    waitForTreeRootMock.mockResolvedValue(null);
    getLocalRootCacheMock.mockReturnValue(undefined);
    getLocalRootKeyMock.mockReturnValue(undefined);
    getTreeMock.mockReturnValue({ resolvePath: vi.fn() } as never);
  });

  it('uses top-level tree name for local cache fallback on nested repo refs', async () => {
    const npub = 'npub1test';
    const rootHash = new Uint8Array([1, 2, 3]);
    const rootKey = new Uint8Array([4, 5, 6]);
    const nestedCid = makeCid(9);
    const resolvePath = vi.fn().mockResolvedValue({ cid: nestedCid, type: LinkType.Dir });

    getLocalRootCacheMock.mockImplementation((_npub, treeName) => (treeName === 'tree' ? rootHash : undefined));
    getLocalRootKeyMock.mockImplementation((_npub, treeName) => (treeName === 'tree' ? rootKey : undefined));
    getTreeMock.mockReturnValue({ resolvePath } as never);

    const result = await resolveRepoRootCid({
      identifier: npub,
      repoName: 'tree/subrepo',
      visibility: 'public',
    });

    expect(result).toBe(nestedCid);
    expect(getLocalRootCacheMock).toHaveBeenCalledWith(npub, 'tree');
    expect(getLocalRootKeyMock).toHaveBeenCalledWith(npub, 'tree');
    expect(waitForTreeRootMock).not.toHaveBeenCalled();

    const [cidArg, pathArg] = resolvePath.mock.calls[0];
    expect((cidArg as CID).hash).toBe(rootHash);
    expect((cidArg as CID).key).toBe(rootKey);
    expect(pathArg).toBe('subrepo');
  });

  it('uses top-level tree subscription fallback and resolves nested path', async () => {
    const rootCid = { hash: new Uint8Array([7]), key: new Uint8Array([8]) };
    const nestedCid = makeCid(10);
    const resolvePath = vi.fn().mockResolvedValue({ cid: nestedCid, type: LinkType.Dir });

    waitForTreeRootMock.mockResolvedValue(rootCid);
    getTreeMock.mockReturnValue({ resolvePath } as never);

    const result = await resolveRepoRootCid(
      {
        identifier: 'npub1abc',
        repoName: 'tree/nested/repo',
        visibility: 'public',
      },
      { timeoutMs: 1234 }
    );

    expect(result).toBe(nestedCid);
    expect(waitForTreeRootMock).toHaveBeenCalledWith('npub1abc', 'tree', 1234);
    expect(resolvePath).toHaveBeenCalledWith(rootCid, 'nested/repo');
  });

  it('returns null when nested repo path does not resolve to a directory', async () => {
    const rootCid = makeCid(11);
    const resolvePath = vi.fn().mockResolvedValue({ cid: makeCid(12), type: LinkType.Blob });

    waitForTreeRootMock.mockResolvedValue(rootCid);
    getTreeMock.mockReturnValue({ resolvePath } as never);

    const result = await resolveRepoRootCid({
      identifier: 'npub1abc',
      repoName: 'tree/subrepo',
      visibility: 'public',
    });

    expect(result).toBeNull();
    expect(resolvePath).toHaveBeenCalledWith(rootCid, 'subrepo');
  });

  it('keeps non-nested repo fallback behavior unchanged', async () => {
    const hash = new Uint8Array([20]);
    const key = new Uint8Array([21]);
    const resolvePath = vi.fn();

    getLocalRootCacheMock.mockReturnValue(hash);
    getLocalRootKeyMock.mockReturnValue(key);
    getTreeMock.mockReturnValue({ resolvePath } as never);

    const result = await resolveRepoRootCid({
      identifier: 'npub1abc',
      repoName: 'tree',
      visibility: 'public',
    });

    expect(result).toEqual({ hash, key });
    expect(getLocalRootCacheMock).toHaveBeenCalledWith('npub1abc', 'tree');
    expect(waitForTreeRootMock).not.toHaveBeenCalled();
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it('returns adapter-resolved CID directly without fallback path resolution', async () => {
    const adapterCid = makeCid(30);
    const resolveRoot = vi.fn().mockResolvedValue(adapterCid);

    getWorkerAdapterMock.mockReturnValue({ resolveRoot } as never);

    const result = await resolveRepoRootCid({
      identifier: 'npub1abc',
      repoName: 'tree/subrepo',
      visibility: 'public',
    });

    expect(result).toBe(adapterCid);
    expect(resolveRoot).toHaveBeenCalledWith('npub1abc', 'tree/subrepo');
    expect(getLocalRootCacheMock).not.toHaveBeenCalled();
    expect(waitForTreeRootMock).not.toHaveBeenCalled();
    expect(getTreeMock).not.toHaveBeenCalled();
  });
});
