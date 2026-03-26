import { describe, expect, it } from 'vitest';
import { resolveGitViewContext } from '../src/utils/gitViewContext';

describe('resolveGitViewContext', () => {
  it('uses the git root path when navigating inside a nested repo', () => {
    expect(resolveGitViewContext({
      treeName: 'public',
      gitRootPath: 'repo-name',
      currentPath: ['repo-name', 'src', 'components', 'App.svelte'],
    })).toEqual({
      repoName: 'repo-name',
      relativePathParts: ['src', 'components', 'App.svelte'],
      label: 'repo-name / src / components / App.svelte',
    });
  });

  it('falls back to the current directory when the repo root is the viewed directory', () => {
    expect(resolveGitViewContext({
      treeName: 'public',
      gitRootPath: null,
      fallbackGitRootParts: ['repo-name'],
      currentPath: ['repo-name', 'README.md'],
    })).toEqual({
      repoName: 'repo-name',
      relativePathParts: ['README.md'],
      label: 'repo-name / README.md',
    });
  });

  it('uses the tree name for top-level repos at the tree root', () => {
    expect(resolveGitViewContext({
      treeName: 'hashtree',
      gitRootPath: '',
      currentPath: ['src'],
    })).toEqual({
      repoName: 'hashtree',
      relativePathParts: ['src'],
      label: 'hashtree / src',
    });
  });

  it('keeps the repo name visible at the repo root', () => {
    expect(resolveGitViewContext({
      treeName: 'hashtree',
      gitRootPath: null,
      fallbackGitRootParts: [],
      currentPath: [],
    })).toEqual({
      repoName: 'hashtree',
      relativePathParts: [],
      label: 'hashtree',
    });
  });
});
