import { LinkType, type CID, type TreeVisibility } from '@hashtree/core';
import { parseHtreeUrl } from '@hashtree/git';
import { getWorkerAdapter } from '../lib/workerInit';
import { waitForTreeRoot } from '../stores/treeRoot';
import { getLocalRootCache, getLocalRootKey } from '../treeRootCache';
import { getTree } from '../store';

export interface ParsedHtreeRepoRef {
  identifier: string;
  repoName: string;
  visibility: TreeVisibility;
  linkKeyHex?: string;
}

export function parseHtreeRepoRef(input: string): ParsedHtreeRepoRef {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Source repository URL is empty');
  }

  if (trimmed.startsWith('htree://')) {
    const parsed = parseHtreeUrl(trimmed);
    return {
      identifier: parsed.identifier,
      repoName: parsed.repo,
      visibility: parsed.visibility,
      linkKeyHex: parsed.linkKey,
    };
  }

  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return {
      identifier: parts[0],
      repoName: parts.slice(1).join('/'),
      visibility: 'public',
    };
  }

  throw new Error('Invalid source repository URL. Use htree://npub/repo or npub/repo.');
}

export function resolveRepoRefIdentifierToNpub(ref: ParsedHtreeRepoRef, selfNpub?: string): string {
  if (ref.identifier === 'self') {
    if (!selfNpub) {
      throw new Error('Cannot resolve htree://self/... here. Use an npub clone URL instead.');
    }
    return selfNpub;
  }

  if (!ref.identifier.startsWith('npub1')) {
    throw new Error(`Unsupported source repository identifier: ${ref.identifier}`);
  }

  return ref.identifier;
}

export function isSameRepoRef(
  ref: ParsedHtreeRepoRef,
  targetNpub: string,
  targetRepoName: string,
  options?: { selfNpub?: string }
): boolean {
  let sourceNpub: string;
  try {
    sourceNpub = resolveRepoRefIdentifierToNpub(ref, options?.selfNpub);
  } catch {
    return false;
  }
  return sourceNpub === targetNpub && ref.repoName === targetRepoName;
}

function splitRepoRootAndNestedPath(repoName: string): { rootRepoName: string; nestedRepoPath: string | null } {
  const parts = repoName.split('/').filter(Boolean);
  if (parts.length === 0) {
    throw new Error('Invalid repository name');
  }
  return {
    rootRepoName: parts[0],
    nestedRepoPath: parts.length > 1 ? parts.slice(1).join('/') : null,
  };
}

async function resolveNestedRepoPath(rootCid: CID, nestedRepoPath: string | null): Promise<CID | null> {
  if (!nestedRepoPath) return rootCid;

  const tree = getTree();
  const resolved = await tree.resolvePath(rootCid, nestedRepoPath);
  if (!resolved || resolved.type !== LinkType.Dir) {
    return null;
  }
  return resolved.cid;
}

export async function resolveRepoRootCid(
  ref: ParsedHtreeRepoRef,
  options?: { selfNpub?: string; timeoutMs?: number }
): Promise<CID | null> {
  const npub = resolveRepoRefIdentifierToNpub(ref, options?.selfNpub);
  const timeoutMs = options?.timeoutMs ?? 10000;
  const { rootRepoName, nestedRepoPath } = splitRepoRootAndNestedPath(ref.repoName);

  const adapter = getWorkerAdapter();
  if (adapter) {
    try {
      const cid = await adapter.resolveRoot(npub, ref.repoName);
      if (cid) return cid;
    } catch {
      // Fall back to local cache + resolver subscription path.
    }
  }

  const localHash = getLocalRootCache(npub, rootRepoName);
  if (localHash) {
    return await resolveNestedRepoPath({ hash: localHash, key: getLocalRootKey(npub, rootRepoName) }, nestedRepoPath);
  }

  const rootCid = await waitForTreeRoot(npub, rootRepoName, timeoutMs);
  if (!rootCid) return null;
  return await resolveNestedRepoPath(rootCid, nestedRepoPath);
}
