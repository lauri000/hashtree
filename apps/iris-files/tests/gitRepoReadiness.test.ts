import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkType, type CID } from '@hashtree/core';

const diffBranchesWasm = vi.fn();
const canMergeWasm = vi.fn();
const mergeWasm = vi.fn();

let resolvePathMock = vi.fn();

vi.mock('../src/store', () => ({
  getTree: () => ({
    resolvePath: (...args: unknown[]) => resolvePathMock(...args),
  }),
  decodeAsText: vi.fn(),
}));

vi.mock('../src/utils/wasmGit', () => ({
  diffBranchesWasm,
  canMergeWasm,
  mergeWasm,
}));

import { canMerge, diffBranches, mergeBranches } from '../src/utils/git';

function cid(byte: number): CID {
  return { hash: new Uint8Array([byte]), key: undefined } as CID;
}

function mockHydratingRepo(missingAttempts: number): void {
  const gitDirCid = cid(9);
  const headCid = cid(10);
  let attempts = 0;

  resolvePathMock = vi.fn(async (_rootCid: CID, path: string) => {
    if (path === '.git') {
      attempts += 1;
      if (attempts <= missingAttempts) {
        return null;
      }
      return { cid: gitDirCid, type: LinkType.Dir };
    }

    if (path === 'HEAD') {
      return { cid: headCid, type: LinkType.Blob };
    }

    return null;
  });
}

describe('git repo readiness wrappers', () => {
  const rootCid = cid(1);

  beforeEach(() => {
    vi.useFakeTimers();
    diffBranchesWasm.mockReset();
    canMergeWasm.mockReset();
    mergeWasm.mockReset();
    resolvePathMock = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for git metadata before diffing branches', async () => {
    mockHydratingRepo(2);
    diffBranchesWasm.mockResolvedValue({
      diff: 'diff --git a/file.txt b/file.txt',
      stats: { additions: 1, deletions: 0, files: ['file.txt'] },
      canFastForward: true,
    });

    const resultPromise = diffBranches(rootCid, 'master', 'feature');
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      diff: 'diff --git a/file.txt b/file.txt',
      stats: { additions: 1, deletions: 0, files: ['file.txt'] },
      canFastForward: true,
    });
    expect(diffBranchesWasm).toHaveBeenCalledOnce();
    expect(diffBranchesWasm).toHaveBeenCalledWith(rootCid, 'master', 'feature');
  });

  it('waits for git metadata before checking mergeability', async () => {
    mockHydratingRepo(1);
    canMergeWasm.mockResolvedValue({
      canMerge: true,
      conflicts: [],
      isFastForward: false,
    });

    const resultPromise = canMerge(rootCid, 'master', 'feature');
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      canMerge: true,
      conflicts: [],
      isFastForward: false,
    });
    expect(canMergeWasm).toHaveBeenCalledOnce();
    expect(canMergeWasm).toHaveBeenCalledWith(rootCid, 'master', 'feature');
  });

  it('returns a repo error after merge readiness retries are exhausted', async () => {
    resolvePathMock = vi.fn(async () => null);

    const resultPromise = mergeBranches(rootCid, 'master', 'feature', 'Merge feature');
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      success: false,
      error: 'Not a git repository',
    });
    expect(mergeWasm).not.toHaveBeenCalled();
  });
});
