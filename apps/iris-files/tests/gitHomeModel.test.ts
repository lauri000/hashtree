import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../src/stores';
import { buildGitHomeRepos } from '../src/components/Git/homeModel';

function tree(overrides: Partial<TreeEntry> & { name: string; labels?: string[] }): TreeEntry {
  return {
    key: `npub1test/${overrides.name}`,
    name: overrides.name,
    hash: new Uint8Array(32),
    hashHex: '00'.repeat(32),
    visibility: 'public',
    ...overrides,
  };
}

describe('buildGitHomeRepos', () => {
  it('keeps only trees tagged as git repos and sorts newest first', () => {
    const repos = buildGitHomeRepos([
      tree({ name: 'notes', createdAt: 30, labels: ['docs'] }),
      tree({ name: 'old-repo', createdAt: 10, labels: ['git'] }),
      tree({ name: 'new-repo', createdAt: 20, labels: ['hashtree', 'git'] }),
      tree({ name: 'misc', createdAt: 40 }),
    ]);

    expect(repos.map(repo => repo.name)).toEqual(['new-repo', 'old-repo']);
  });

  it('falls back to alphabetical order when timestamps are missing', () => {
    const repos = buildGitHomeRepos([
      tree({ name: 'zeta', labels: ['git'] }),
      tree({ name: 'alpha', labels: ['git'] }),
    ]);

    expect(repos.map(repo => repo.name)).toEqual(['alpha', 'zeta']);
  });
});
