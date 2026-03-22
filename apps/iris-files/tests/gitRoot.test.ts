import { describe, expect, it } from 'vitest';
import type { CID } from '@hashtree/core';
import { findNearestGitRootPath } from '../src/utils/gitRoot';

function cid(label: string): CID {
  return { hash: new Uint8Array([label.length]), key: undefined } as CID;
}

describe('findNearestGitRootPath', () => {
  it('returns the tree root when a nested path lives inside a root-level repo', async () => {
    const rootCid = cid('root');
    const appsCid = cid('apps');
    const appCid = cid('app');

    const pathMap = new Map<string, CID>([
      ['apps', appsCid],
      ['apps/hashtree-cc', appCid],
    ]);

    const gitRepos = new Set<CID>([rootCid]);

    const result = await findNearestGitRootPath(rootCid, ['apps', 'hashtree-cc'], {
      tree: {
        async resolvePath(_root, path) {
          const found = pathMap.get(path);
          return found ? { cid: found } : null;
        },
      },
      async isGitRepoFn(candidateCid) {
        return gitRepos.has(candidateCid);
      },
    });

    expect(result).toBe('');
  });

  it('returns the nearest ancestor repo when the repo is nested inside another tree', async () => {
    const rootCid = cid('root');
    const projectsCid = cid('projects');
    const repoCid = cid('repo');
    const srcCid = cid('src');

    const pathMap = new Map<string, CID>([
      ['projects', projectsCid],
      ['projects/demo-repo', repoCid],
      ['projects/demo-repo/src', srcCid],
    ]);

    const gitRepos = new Set<CID>([repoCid]);

    const result = await findNearestGitRootPath(rootCid, ['projects', 'demo-repo', 'src'], {
      tree: {
        async resolvePath(_root, path) {
          const found = pathMap.get(path);
          return found ? { cid: found } : null;
        },
      },
      async isGitRepoFn(candidateCid) {
        return gitRepos.has(candidateCid);
      },
    });

    expect(result).toBe('projects/demo-repo');
  });

  it('returns null when no ancestor is a git repo', async () => {
    const rootCid = cid('root');
    const docsCid = cid('docs');

    const result = await findNearestGitRootPath(rootCid, ['docs'], {
      tree: {
        async resolvePath(_root, path) {
          return path === 'docs' ? { cid: docsCid } : null;
        },
      },
      async isGitRepoFn() {
        return false;
      },
    });

    expect(result).toBeNull();
  });
});
