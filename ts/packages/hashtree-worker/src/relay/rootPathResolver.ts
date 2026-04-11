import type { CID, HashTree } from '@hashtree/core';
import { resolveTreeRootNow } from './treeRootSubscription';

export const DEFAULT_ROOT_PATH_RESOLVE_TIMEOUT_MS = 15_000;

export interface ParsedRootPath {
  treeName: string;
  subPath: string[];
}

export function parseRootPath(path?: string): ParsedRootPath {
  const pathParts = path?.split('/').filter(Boolean) ?? [];
  return {
    treeName: pathParts[0] || 'public',
    subPath: pathParts.slice(1),
  };
}

export async function resolveRootPath(
  tree: Pick<HashTree, 'resolvePath'> | null,
  npub: string,
  path?: string,
  timeoutMs: number = DEFAULT_ROOT_PATH_RESOLVE_TIMEOUT_MS,
): Promise<CID | null> {
  const exactTreeName = path?.split('/').filter(Boolean).join('/') || 'public';
  const exactRootCid = await resolveTreeRootNow(npub, exactTreeName, timeoutMs);
  if (exactRootCid) {
    return exactRootCid;
  }

  const { treeName, subPath } = parseRootPath(path);
  if (subPath.length === 0) {
    return null;
  }

  const rootCid = await resolveTreeRootNow(npub, treeName, timeoutMs);
  if (!rootCid) {
    return null;
  }

  if (subPath.length === 0) {
    return rootCid;
  }

  if (!tree) {
    throw new Error('Tree not initialized');
  }

  return (await tree.resolvePath(rootCid, subPath))?.cid ?? null;
}
