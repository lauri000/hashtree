import { describe, expect, it } from 'vitest';
import { resolveGitRootPathParam, resolveGitViewContext } from '../src/utils/gitViewContext';

describe('gitViewContext', () => {
  it('keeps empty g param at tree-root repos while browsing subdirectories', () => {
    expect(resolveGitRootPathParam('', ['apps'])).toBe('');
    expect(resolveGitViewContext({
      treeName: 'hashtree',
      gitRootPath: '',
      currentPath: ['apps', 'iris-files'],
    })).toEqual({
      rootParts: [],
      repoName: 'hashtree',
      relativePathParts: ['apps', 'iris-files'],
      label: 'hashtree / apps / iris-files',
    });
  });

  it('uses the current path as the repo root only when no g param exists yet', () => {
    expect(resolveGitRootPathParam(null, ['projects', 'demo-repo'])).toBe('projects/demo-repo');
    expect(resolveGitRootPathParam('projects/demo-repo', ['projects', 'demo-repo', 'src'])).toBe('projects/demo-repo');
  });

  it('does not use hidden non-visible g values as the displayed repo name', () => {
    expect(resolveGitViewContext({
      treeName: 'hashtree',
      gitRootPath: '.hashtree',
      currentPath: ['apps', 'iris', 'scripts'],
    })).toEqual({
      rootParts: [],
      repoName: 'hashtree',
      relativePathParts: ['apps', 'iris', 'scripts'],
      label: 'hashtree / apps / iris / scripts',
    });
  });
});
