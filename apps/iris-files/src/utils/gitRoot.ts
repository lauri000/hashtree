import type { CID } from '@hashtree/core';
import { getTree } from '../store';
import { isGitRepo } from './git';

type ResolveResult = { cid: CID } | null;

interface TreeResolver {
  resolvePath(rootCid: CID, path: string): Promise<ResolveResult>;
}

interface FindNearestGitRootOptions {
  tree?: TreeResolver;
  isGitRepoFn?: (cid: CID) => Promise<boolean>;
}

async function resolveCandidateCid(tree: TreeResolver, rootCid: CID, pathParts: string[]): Promise<CID | null> {
  if (pathParts.length === 0) {
    return rootCid;
  }

  const result = await tree.resolvePath(rootCid, pathParts.join('/'));
  return result?.cid ?? null;
}

export async function findNearestGitRootPath(
  rootCid: CID | null,
  currentPath: string[],
  options: FindNearestGitRootOptions = {}
): Promise<string | null> {
  if (!rootCid) {
    return null;
  }

  const tree = options.tree ?? getTree();
  const isGitRepoFn = options.isGitRepoFn ?? isGitRepo;

  for (let depth = currentPath.length; depth >= 0; depth -= 1) {
    const candidateParts = currentPath.slice(0, depth);
    const candidateCid = await resolveCandidateCid(tree, rootCid, candidateParts);
    if (!candidateCid) {
      continue;
    }
    if (await isGitRepoFn(candidateCid)) {
      return candidateParts.join('/');
    }
  }

  return null;
}
