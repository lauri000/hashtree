import type { TreeEntry } from '../../stores';

export interface GitHomeRepo extends TreeEntry {
  labelSet: Set<string>;
}

export function buildGitHomeRepos(trees: TreeEntry[]): GitHomeRepo[] {
  return trees
    .filter(tree => (tree.labels ?? []).includes('git'))
    .sort((a, b) => {
      const createdAtDiff = (b.createdAt ?? 0) - (a.createdAt ?? 0);
      if (createdAtDiff !== 0) {
        return createdAtDiff;
      }
      return a.name.localeCompare(b.name);
    })
    .map(tree => ({
      ...tree,
      labelSet: new Set(tree.labels ?? []),
    }));
}
