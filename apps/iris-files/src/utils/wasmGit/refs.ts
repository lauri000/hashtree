import { LinkType, type CID, type TreeEntry } from '@hashtree/core';

export interface GitTreeReader {
  resolvePath(rootCid: CID, path: string): Promise<{ cid: CID; type: LinkType } | null>;
  readFile(cid: CID): Promise<Uint8Array | null>;
  listDirectory(cid: CID): Promise<TreeEntry[]>;
}

export interface PackedRefEntry {
  sha: string;
  peeled?: string;
}

export function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

export function normalizeSha(value: string): string | null {
  return isFullSha(value) ? value.toLowerCase() : null;
}

export function parsePackedRefs(content: string): Map<string, PackedRefEntry> {
  const refs = new Map<string, PackedRefEntry>();
  let lastRef: string | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('^')) {
      if (!lastRef) continue;
      const peeled = normalizeSha(line.slice(1));
      if (!peeled) continue;
      const current = refs.get(lastRef);
      if (current) {
        refs.set(lastRef, { ...current, peeled });
      }
      continue;
    }

    const [shaValue, refPath] = line.split(/\s+/, 2);
    const sha = normalizeSha(shaValue ?? '');
    if (!sha || !refPath) {
      lastRef = null;
      continue;
    }

    refs.set(refPath, { sha });
    lastRef = refPath;
  }

  return refs;
}

export async function readPackedRefs(tree: GitTreeReader, gitDirCid: CID): Promise<Map<string, PackedRefEntry>> {
  try {
    const packedRefsResult = await tree.resolvePath(gitDirCid, 'packed-refs');
    if (!packedRefsResult || packedRefsResult.type === LinkType.Dir) {
      return new Map();
    }

    const packedRefsData = await tree.readFile(packedRefsResult.cid);
    if (!packedRefsData) {
      return new Map();
    }

    return parsePackedRefs(new TextDecoder().decode(packedRefsData));
  } catch {
    return new Map();
  }
}

export async function readRefSha(tree: GitTreeReader, gitDirCid: CID, refPath: string): Promise<string | null> {
  try {
    const refResult = await tree.resolvePath(gitDirCid, refPath);
    if (!refResult || refResult.type === LinkType.Dir) {
      return null;
    }

    const refData = await tree.readFile(refResult.cid);
    if (!refData) {
      return null;
    }

    return normalizeSha(new TextDecoder().decode(refData).trim());
  } catch {
    return null;
  }
}

export async function collectLooseRefs(tree: GitTreeReader, gitDirCid: CID, refRoot: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();

  try {
    const refRootResult = await tree.resolvePath(gitDirCid, refRoot);
    if (!refRootResult || refRootResult.type !== LinkType.Dir) {
      return refs;
    }

    const walk = async (dirCid: CID, prefix: string): Promise<void> => {
      const entries = await tree.listDirectory(dirCid);
      const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of sortedEntries) {
        const refName = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.type === LinkType.Dir) {
          await walk(entry.cid, refName);
          continue;
        }

        const sha = await readRefSha(tree, dirCid, entry.name);
        if (sha) {
          refs.set(refName, sha);
        }
      }
    };

    await walk(refRootResult.cid, '');
  } catch {
    return refs;
  }

  return refs;
}
